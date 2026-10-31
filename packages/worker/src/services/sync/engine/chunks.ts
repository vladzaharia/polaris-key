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
    const stored = store.getChunk(upload.collection, id);
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

/** Whether a chunk row has any reason to stay: a file names it or an upload pins it. */
export const chunkInUse = (store: SyncStore, c: StoredChunk): boolean =>
  c.refs > 0 || store.chunkPinned(c.collection, c.chunkId);
