/**
 * Delta files, the engine's half (U-37; WIRE-CONTRACT-V5 §13.8.3, plans/U-22-U-23-U-37-U-41-slices.md
 * §3.1). Pure functions over a `SyncStore`: no R2, no clock of their own, no I/O. The Durable
 * Object makes the R2 control calls around them, and the Worker streams the bytes.
 *
 * ── THE MODEL ────────────────────────────────────────────────────────────────────────────────
 *
 *   A chunk is one object per (person, collection, chunk id), `chunks` row `(collection, chunkId)`.
 *   Its `refs` is how many stored file versions (live, revision or parked) name it
 *   (`file_chunks`). Its bytes are charged to the quota once while `refs` is above 0 and given
 *   back when it falls to 0; a chunk with no reference is collected by the alarm, unless an upload
 *   still pins it (`upload_chunks`).
 *
 *   A plan call names chunks for an open upload. It reserves the stored bytes of every named chunk
 *   that no file references (those will be charged at `finalize`), and pins every named chunk to the
 *   upload (D-7): a `present` answer is a promise the chunk is still there at `finalize`.
 *
 *   The reservation is released as a whole when the upload ends (`finalize` replaces it with the
 *   charge; `DELETE` and expiry give it back), exactly as for a part upload.
 */

import {
  SYNC_CHUNK_MAX_STORED_BYTES,
  SYNC_MAX_CHUNKS_PER_FILE,
  type SyncChunkRef,
} from "@polaris-key/protocol/sync";
import type { FileLimits } from "./files.js";
import type { StoredChunk, SyncStore, UploadRow } from "./types.js";
import { fileUsage, moveReserved } from "./usage.js";

/** The smallest stored chunk object: server mode is `0x00 codec` and one byte; E2E adds 12 + 16 + 1. */
export const CHUNK_MIN_STORED_BYTES = { none: 3, e2e: 31 } as const;

/** The R2 key of a chunk object. Only ever built here, from the pin, a collection and an id. */
export const chunkObjectKey = (
  pin: { product: string; subject: string },
  collection: string,
  chunkId: string,
): string => `u/${pin.product}/${pin.subject}/c/${collection}/${chunkId}`;

/**
 * The `unrefAt` of a chunk row whose object the collector has begun to delete: the object may be
 * gone, so the row answers `missing` at a plan call and a `PUT` stores it again. It sorts before
 * every real time, so a marked row is the first the collector retries.
 */
export const CHUNK_COLLECTING = -1;

/** A chunk id as the wire writes it. */
const CHUNK_ID = /^[0-9a-f]{64}$/;

export type PlanRefusal =
  | { ok: false; error: "bad_request" }
  | { ok: false; error: "file_too_large" }
  | {
      ok: false;
      error: "quota_exceeded";
      scope: "user" | "product";
    };

export type PlanOutcome =
  | { ok: true; missing: string[]; present: SyncChunkRef[] }
  | PlanRefusal;

export interface PlanInput {
  upload: UploadRow;
  chunks: readonly SyncChunkRef[];
  /** The matched declaration's `files.maxBytes`. */
  maxBytes: number;
  limits: FileLimits;
}

/**
 * Answers one plan call and applies it. A refusal writes nothing. The caller runs this in one
 * transaction on an `open` upload of mode `chunks`.
 *
 * Every named id is answered exactly once: `present` (the collection stores the chunk, whatever the
 * size the caller guessed; the answer carries the stored size) or `missing`. Naming an id again
 * re-evaluates it, so a chunk that arrived since is `present` now.
 */
export function planChunks(store: SyncStore, input: PlanInput): PlanOutcome {
  const { upload, limits } = input;
  const min = CHUNK_MIN_STORED_BYTES[upload.enc];
  const seen = new Set<string>();
  for (const [id, bytes] of input.chunks) {
    if (
      typeof id !== "string" ||
      !CHUNK_ID.test(id) ||
      seen.has(id) ||
      !Number.isSafeInteger(bytes) ||
      bytes < min ||
      bytes > SYNC_CHUNK_MAX_STORED_BYTES
    )
      return { ok: false, error: "bad_request" };
    seen.add(id);
  }

  const have = new Map(
    store.uploadChunks(upload.uploadId).map((r) => [r.chunkId, r] as const),
  );
  let distinct = have.size;
  for (const id of seen) if (!have.has(id)) distinct++;
  if (distinct > SYNC_MAX_CHUNKS_PER_FILE)
    return { ok: false, error: "bad_request" };

  const missing: string[] = [];
  const present: SyncChunkRef[] = [];
  const rows = new Map<
    string,
    { storedBytes: number; have: boolean; reserved: number }
  >();
  let delta = 0;
  for (const [id, declared] of input.chunks) {
    const found = store.getChunk(upload.collection, id);
    // A row the collector has begun to delete may point at nothing: it is no row.
    const stored = found?.unrefAt === CHUNK_COLLECTING ? undefined : found;
    const prior = have.get(id);
    // A chunk this upload already holds stays present even if the row was replaced meanwhile.
    const row = stored
      ? {
          storedBytes: stored.storedBytes,
          have: true,
          // A chunk some file references is charged already; any other is charged at `finalize`.
          reserved: stored.refs === 0 ? stored.storedBytes : 0,
        }
      : { storedBytes: declared, have: false, reserved: declared };
    rows.set(id, row);
    delta += row.reserved - (prior?.reserved ?? 0);
    if (row.have) present.push([id, row.storedBytes]);
    else missing.push(id);
  }

  // The file's declared size: the manifest plus every distinct chunk, as named so far.
  let total = upload.size;
  for (const [id, r] of have)
    total += rows.get(id)?.storedBytes ?? r.storedBytes;
  for (const [id, r] of rows) if (!have.has(id)) total += r.storedBytes;
  if (total > input.maxBytes) return { ok: false, error: "file_too_large" };

  if (delta > 0) {
    const usage = store.getUsage();
    if (
      limits.productOverCeiling ||
      (limits.usersAtCeiling && !store.heldData())
    )
      return { ok: false, error: "quota_exceeded", scope: "product" };
    if (
      limits.quotaBytes <= 0 ||
      usage.bytes + fileUsage(usage).reservedBytes + delta > limits.quotaBytes
    )
      return { ok: false, error: "quota_exceeded", scope: "user" };
  }

  for (const [id, r] of rows)
    store.putUploadChunk({ uploadId: upload.uploadId, chunkId: id, ...r });
  if (delta !== 0) {
    moveReserved(store, delta);
    store.putUpload({
      ...upload,
      reservedBytes: Math.max(0, upload.reservedBytes + delta),
    });
  }
  return { ok: true, missing, present };
}

/** The chunk ids an upload still lacks, in id order. */
export function missingChunks(store: SyncStore, uploadId: string): string[] {
  return store
    .uploadChunks(uploadId)
    .filter((c) => !c.have)
    .map((c) => c.chunkId);
}

/** What the Worker needs to stream a chunk `PUT`: nothing (it landed or is not asked for) or the size to expect. */
export type ChunkPrepare =
  | { kind: "unplanned" }
  | { kind: "have" }
  | { kind: "send"; storedBytes: number };

/** The `PUT` of `chunkId` against what the plan answered: only an id it answered `missing` is sent. */
export function prepareChunk(
  store: SyncStore,
  upload: UploadRow,
  chunkId: string,
): ChunkPrepare {
  const row = store.getUploadChunk(upload.uploadId, chunkId);
  if (!row) return { kind: "unplanned" };
  return row.have
    ? { kind: "have" }
    : { kind: "send", storedBytes: row.storedBytes };
}

export interface StoredInput {
  collection: string;
  chunkId: string;
  objectKey: string;
  storedBytes: number;
  ssecKid?: string;
  nowMs: number;
}

/**
 * Records a chunk object that is in R2. The chunk row exists from here on, unreferenced until a
 * `finalize` names it, and the collector takes it if nothing does. An existing row stays as it is
 * (same collection and id means the same object). `upload` is the session the bytes came for, or
 * undefined when it closed meanwhile; the chunk is recorded all the same, so the object is never
 * left without a row to collect it by.
 */
export function storeChunk(
  store: SyncStore,
  input: StoredInput,
  upload: UploadRow | undefined,
): StoredChunk {
  const found = store.getChunk(input.collection, input.chunkId);
  // The object is in R2 now: a row the collector had begun to delete is replaced, not kept.
  const prior = found?.unrefAt === CHUNK_COLLECTING ? undefined : found;
  const row: StoredChunk = prior ?? {
    collection: input.collection,
    chunkId: input.chunkId,
    objectKey: input.objectKey,
    storedBytes: input.storedBytes,
    refs: 0,
    unrefAt: input.nowMs,
    ...(input.ssecKid !== undefined ? { ssecKid: input.ssecKid } : {}),
  };
  if (!prior) store.putChunk(row);
  if (upload) {
    const planned = store.getUploadChunk(upload.uploadId, input.chunkId);
    if (planned) store.putUploadChunk({ ...planned, have: true });
  }
  return row;
}

// ── references (§13.8.3; the quota rule of §13.8.2) ──────────────────────────────────────────

/**
 * Moves the quota total and the files' byte counter by the stored size of a chunk. Chunk bytes are
 * kept in `fileBytes` (and in `bytes`, the quota's measure), so the directory's breakdown stays
 * whole: a chunk counts once however many files, revisions and parked copies name it.
 */
function chargeChunk(store: SyncStore, delta: number): void {
  const u = store.getUsage();
  const f = fileUsage(u);
  store.setUsage({
    ...u,
    bytes: Math.max(0, u.bytes + delta),
    fileBytes: Math.max(0, f.fileBytes + delta),
  });
}

/**
 * The stored bytes of the chunks an upload names that no file references now and that the upload
 * did not reserve: a chunk its plan answered `present` whose last reference went afterwards. They
 * are charged at `finalize` (the first reference), so `finalize` checks them against the quota.
 */
export function unreservedChunkBytes(
  store: SyncStore,
  upload: UploadRow,
): number {
  let extra = 0;
  for (const r of store.uploadChunks(upload.uploadId)) {
    const c = store.getChunk(upload.collection, r.chunkId);
    if (c && c.refs === 0) extra += Math.max(0, c.storedBytes - r.reserved);
  }
  return extra;
}

/** The identity of a stored file version. */
export interface FileRef {
  collection: string;
  recordId: string;
  version: number;
}

/**
 * A stored file version names `chunkIds`: takes one reference on each. The first reference of a
 * chunk charges its stored bytes (a chunk some file references already is charged). Every id must
 * have a chunk row: a plan call pinned it, and nothing deletes a pinned chunk.
 */
export function refFileChunks(
  store: SyncStore,
  file: FileRef,
  chunkIds: readonly string[],
): void {
  const ids = [...new Set(chunkIds)];
  for (const id of ids) {
    const c = store.getChunk(file.collection, id);
    if (!c) throw new Error("chunk: a file names a chunk with no row");
    if (c.refs === 0) chargeChunk(store, c.storedBytes);
    store.putChunk({ ...c, refs: c.refs + 1, unrefAt: 0 });
  }
  store.putFileChunks(file.collection, file.recordId, file.version, ids);
}

/**
 * A stored file version stops naming its chunks (it died: a revision pruned, a record deleted, a
 * copy a merge left dead): drops one reference from each, never below zero, and gives a chunk's
 * bytes back when its last reference goes. The rows go with it, so a repeat finds nothing to drop.
 * Returns how many chunks ended up with no reference.
 */
export function unrefFileChunks(
  store: SyncStore,
  file: FileRef,
  nowMs = 0,
): number {
  let freed = 0;
  for (const id of store.fileChunkIds(
    file.collection,
    file.recordId,
    file.version,
  )) {
    const c = store.getChunk(file.collection, id);
    if (!c) continue;
    const refs = Math.max(0, c.refs - 1);
    if (c.refs > 0 && refs === 0) {
      chargeChunk(store, -c.storedBytes);
      freed++;
    }
    store.putChunk({ ...c, refs, unrefAt: refs === 0 ? nowMs : c.unrefAt });
  }
  store.deleteFileChunks(file.collection, file.recordId, file.version);
  return freed;
}
