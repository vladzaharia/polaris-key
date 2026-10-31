/// <reference types="@cloudflare/workers-types" />
/**
 * The file operations of `CloudSyncDO` (U-10.5; plans/U-10-U-11a-slices.md §2.2): the upload
 * sessions and the R2 control calls. The Worker streams the bytes and chooses the mode; the object
 * owns the state, so every check and every write of a session happens here, one at a time.
 *
 * Each operation that awaits R2 runs under `blockConcurrencyWhile`, so a second `begin` cannot
 * pass the open-upload and quota checks while the first one is waiting for R2.
 *
 * R2 keys come from `fileObjectKey(pin, uploadId)` and nothing else: never from a request path.
 * An expired session is collected when it is next touched (`sweepExpired`, `fileStatus`); the
 * alarm collects the rest (U-10.10).
 */

import { SYNC_MAX_OPEN_UPLOADS } from "@polaris-key/protocol/sync";
import type { UploadStatus } from "@polaris-key/protocol/sync";
import {
  chunkObjectKey,
  missingChunks,
  planChunks,
  prepareChunk,
  storeChunk,
} from "../engine/chunks.js";
import {
  checkBegin,
  commitBegin,
  commitFinalize,
  FILE_SSEC,
  FINALIZE_LEASE_MS,
  fileObjectKey,
  finalizeLease,
  releaseUpload,
} from "../engine/files.js";
import { markDirty } from "./directory.js";
import type { SyncStore, UploadRow } from "../engine/types.js";
import type {
  ChunkPlanOutcome,
  ChunkPrepareOutcome,
  CloudSyncError,
  CloudSyncOp,
  CloudSyncReply,
  DoPin,
  FilePrepareOutcome,
  FinalizeCommitOutcome,
  FinalizePrepareOutcome,
} from "./protocol.js";
import type { FinalizeResponse } from "@polaris-key/protocol/sync";
import { hexEncode } from "../../../platform/bytes.js";
import { randomBytes, randomToken } from "../../../platform/random.js";
import type { SqlStore } from "./sqlStore.js";

/** What an operation hands back to `fetch`: a body in the object's protocol and a status. */
export interface FileReply {
  body: CloudSyncReply | CloudSyncError;
  status: number;
  /** The write changed what the directory reports: the caller marks the flush due. */
  dirty?: boolean;
}

/** What the file operations need from the object. */
export interface FileHost {
  store: SqlStore;
  ctx: DurableObjectState;
  bucket: R2Bucket | undefined;
}

const ok = (body: CloudSyncReply): FileReply => ({ body, status: 200 });

/** The object's own refusal. Written through a variable, not as `error: "<code>"` (see `cloudSyncDo.ts`). */
const refuse = (code: CloudSyncError["error"], status: number): FileReply => ({
  body: { error: code },
  status,
});

/** `meta` flag: this object has had an upload or a file, so its R2 prefix may hold objects. */
export const FILES_USED = "files_used";

/** The first write: makes the schema and pins the pair, in one transaction. */
function pinned(host: FileHost, pin: DoPin): void {
  host.ctx.storage.transactionSync(() => {
    host.store.prepare(true);
    if (host.store.getMeta("product") === undefined) {
      host.store.setMeta("product", pin.product);
      host.store.setMeta("subject", pin.subject);
    }
  });
}

/**
 * Removes what R2 holds for a session that is not finishing: the open multipart upload and the
 * object. Both calls are idempotent here (a missing one is not a failure). `false` when R2 is not
 * reachable or not bound, so the caller keeps the session for a later attempt.
 */
async function dropObjects(
  host: FileHost,
  pin: DoPin,
  u: UploadRow,
): Promise<boolean> {
  if (!host.bucket) return false;
  const key = fileObjectKey(pin, u.uploadId);
  try {
    if (u.multipartId !== null)
      await host.bucket
        .resumeMultipartUpload(key, u.multipartId)
        .abort()
        .catch(() => undefined);
    await host.bucket.delete(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ends a session that has not finished (`DELETE` or expiry): R2 first, then the reservation. A
 * session whose R2 cleanup failed stays as it is, reserved, and is tried again; so the quota never
 * goes back to a person while bytes of theirs may still sit in the bucket.
 */
export async function discard(
  host: FileHost,
  pin: DoPin,
  u: UploadRow,
): Promise<boolean> {
  if (u.state === "done" || u.state === "aborted") return true;
  if (!(await dropObjects(host, pin, u))) return false;
  host.store.transaction(() => releaseUpload(host.store, u));
  return true;
}

// ── SSE-C (D-8) ──────────────────────────────────────────────────────────────────────────────

/** `meta` key naming the person's current SSE-C key (`ssec_keys.kid`). */
const SSEC_KID = "ssec_kid";

/** Whether an upload of this `enc` is stored under the person's SSE-C key. */
const sealed = (enc: UploadRow["enc"]): boolean => FILE_SSEC && enc === "none";

/**
 * The person's SSE-C key id, made on first use: a random 256-bit key kept in `ssec_keys` and shredded
 * with the person's data (`deleteAll`). One key per person; every server-mode file of theirs
 * references it by `files.ssec_kid`, so an absorb carries the keys its files need.
 */
function ensureSsecKey(host: FileHost): string {
  const have = host.store.getMeta(SSEC_KID);
  if (have !== undefined && host.store.getSsecKey(have)) return have;
  const kid = `sk_${randomToken(12)}`;
  const key = randomBytes(32);
  host.store.transaction(() => {
    host.store.putSsecKey(kid, key);
    host.store.setMeta(SSEC_KID, kid);
  });
  return kid;
}

/** The hex of the key an upload of this `enc` is stored under, or undefined when it takes none. */
function ssecKeyOf(host: FileHost, enc: UploadRow["enc"]): string | undefined {
  if (!sealed(enc)) return undefined;
  const kid = host.store.getMeta(SSEC_KID);
  const key = kid === undefined ? undefined : host.store.getSsecKey(kid);
  return key ? hexEncode(key) : undefined;
}

/** Collects expired sessions (a few at a time): finished or ended ones are just forgotten. */
async function sweepExpired(
  host: FileHost,
  pin: DoPin,
  nowMs: number,
  limit = SYNC_MAX_OPEN_UPLOADS * 2,
): Promise<void> {
  for (const u of host.store.expiredUploads(nowMs, limit)) {
    if (u.state === "open" || u.state === "finalizing") {
      if (!(await discard(host, pin, u))) continue;
    }
    host.store.transaction(() => host.store.deleteUpload(u.uploadId));
  }
}

export function fileBegin(
  host: FileHost,
  op: Extract<CloudSyncOp, { op: "fileBegin" }>,
): Promise<FileReply> {
  return host.ctx.blockConcurrencyWhile(async () => {
    pinned(host, op);
    const nowMs = op.serverNow;
    await sweepExpired(host, op, nowMs);
    const out = checkBegin(host.store as SyncStore, {
      uploadId: op.uploadId,
      deviceId: op.deviceId,
      collection: op.collection,
      recordId: op.recordId,
      request: op.request,
      mode: op.mode,
      partBytes: op.partBytes ?? null,
      maxRecords: op.maxRecords,
      limits: op.limits,
      nowMs,
    });
    if (!out.ok) return ok({ op: "fileBegin", outcome: out });
    const upload: UploadRow = { ...out.upload };
    if (sealed(upload.enc)) ensureSsecKey(host);
    if (upload.mode === "multipart") {
      if (!host.bucket) return refuse("unavailable", 503);
      try {
        const ssecKey = ssecKeyOf(host, upload.enc);
        const created = await host.bucket.createMultipartUpload(
          fileObjectKey(op, upload.uploadId),
          ssecKey !== undefined ? { ssecKey } : undefined,
        );
        upload.multipartId = created.uploadId;
      } catch {
        return refuse("unavailable", 503);
      }
    }
    host.store.transaction(() => {
      commitBegin(host.store, upload);
      // An erasure and a merge's delete look in R2 only for a person who ever used it.
      host.store.setMeta(FILES_USED, "1");
    });
    return ok({
      op: "fileBegin",
      outcome: {
        ok: true,
        uploadId: upload.uploadId,
        mode: upload.mode,
        ...(upload.partBytes !== null ? { partBytes: upload.partBytes } : {}),
        expiresAt: upload.expiresAt,
      },
    });
  });
}

/** What names a session: the pin, the record and the session id. */
interface SessionOp extends DoPin {
  collection: string;
  recordId: string;
  uploadId: string;
}

/** The session, if it is this record's and is still there to be spoken of. */
function sessionOf(host: FileHost, op: SessionOp): UploadRow | undefined {
  const u = host.store.getUpload(op.uploadId);
  return u && u.collection === op.collection && u.recordId === op.recordId
    ? u
    : undefined;
}

function statusOf(host: FileHost, u: UploadRow): UploadStatus {
  const parts = host.store.getParts(u.uploadId).map((p) => p.n);
  return {
    mode: u.mode,
    size: u.size,
    ...(u.partBytes !== null ? { partBytes: u.partBytes } : {}),
    // A single `PUT` is part 1, so a client that lost the answer can see whether it landed.
    // A `chunks` upload's manifest is its part 1, and its resume answer lists the chunks it lacks.
    ...(u.mode === "chunks"
      ? { received: parts, missing: missingChunks(host.store, u.uploadId) }
      : { received: parts }),
    expiresAt: u.expiresAt,
  };
}

/** Collects one expired session: its R2 objects and reservation first, then the row. */
function collectExpired(host: FileHost, op: SessionOp): Promise<void> {
  return host.ctx.blockConcurrencyWhile(async () => {
    const again = sessionOf(host, op);
    if (again && (await discard(host, op, again)))
      host.store.transaction(() => host.store.deleteUpload(again.uploadId));
  });
}

/**
 * The session a call speaks of, or why there is none: `not_found` (unknown, another record's,
 * ended, or - when `openOnly` - anything but open), `upload_expired` (past its 24 hours; it is
 * collected here, so the client begins again).
 */
async function liveSession(
  host: FileHost,
  op: SessionOp & { serverNow: number },
  openOnly: boolean,
): Promise<{ u: UploadRow } | { error: "not_found" | "upload_expired" }> {
  host.store.prepare(false);
  const u = sessionOf(host, op);
  if (!u || u.state === "aborted" || (openOnly && u.state !== "open"))
    return { error: "not_found" };
  if (u.expiresAt <= op.serverNow) {
    await collectExpired(host, op);
    return { error: "upload_expired" };
  }
  return { u };
}

export async function fileStatus(
  host: FileHost,
  op: Extract<CloudSyncOp, { op: "fileStatus" }>,
): Promise<FileReply> {
  const s = await liveSession(host, op, false);
  return ok({
    op: "fileStatus",
    outcome:
      "u" in s
        ? { ok: true, status: statusOf(host, s.u) }
        : { ok: false, ...s },
  });
}

export function fileAbort(
  host: FileHost,
  op: Extract<CloudSyncOp, { op: "fileAbort" }>,
): Promise<FileReply> {
  return host.ctx.blockConcurrencyWhile(async () => {
    host.store.prepare(false);
    const u = sessionOf(host, op);
    if (!u)
      return ok({
        op: "fileAbort",
        outcome: { ok: false, error: "not_found" },
      });
    // Ended or finished sessions have nothing left to abort: the call is idempotent.
    if (u.state === "open" || u.state === "finalizing")
      if (!(await discard(host, op, u))) return refuse("unavailable", 503);
    return ok({ op: "fileAbort", outcome: { ok: true } });
  });
}

/**
 * The plan call of a `chunks` upload (U-37.2). The session must be open and in `chunks` mode; the
 * answer and the pins are `engine/chunks.ts`'s, applied in one transaction.
 */
export async function fileChunkPlan(
  host: FileHost,
  op: Extract<CloudSyncOp, { op: "fileChunkPlan" }>,
): Promise<FileReply> {
  const s = await liveSession(host, op, true);
  const answer = (outcome: ChunkPlanOutcome) =>
    ok({ op: "fileChunkPlan", outcome });
  if ("error" in s) return answer({ ok: false, error: s.error });
  if (s.u.mode !== "chunks") return answer({ ok: false, mismatch: true });
  const upload = s.u;
  return answer(
    host.store.transaction(() =>
      planChunks(host.store, {
        upload,
        chunks: op.chunks,
        maxBytes: op.maxBytes,
        limits: op.limits,
      }),
    ),
  );
}

/**
 * What a chunk `PUT` streams against (U-37.3): the session must be open and in `chunks` mode, and
 * the plan must have answered the id `missing`. An id it answered `present` (or that landed
 * already) is `have`: a resend stores nothing.
 */
export async function chunkPrepare(
  host: FileHost,
  op: Extract<CloudSyncOp, { op: "chunkPrepare" }>,
): Promise<FileReply> {
  const s = await liveSession(host, op, true);
  const answer = (outcome: ChunkPrepareOutcome) =>
    ok({ op: "chunkPrepare", outcome });
  if ("error" in s) return answer({ ok: false, error: s.error });
  if (s.u.mode !== "chunks") return answer({ ok: false, mismatch: true });
  const p = prepareChunk(host.store, s.u, op.chunkId);
  if (p.kind === "unplanned") return answer({ ok: false, mismatch: true });
  if (p.kind === "have") return answer({ ok: true, have: true });
  const ssecKey = ssecKeyOf(host, s.u.enc);
  return answer({
    ok: true,
    have: false,
    key: chunkObjectKey(op, op.collection, op.chunkId),
    bytes: p.storedBytes,
    ...(ssecKey !== undefined ? { ssecKey } : {}),
  });
}

/**
 * Records a chunk object R2 took. The chunk row is written whatever became of the session while
 * the bytes were on their way (a row is how the collector finds the object); the session takes the
 * chunk only if it is still open.
 */
export function chunkStored(
  host: FileHost,
  op: Extract<CloudSyncOp, { op: "chunkStored" }>,
): FileReply {
  host.store.prepare(false);
  const u = sessionOf(host, op);
  const open =
    u !== undefined &&
    u.state === "open" &&
    u.mode === "chunks" &&
    u.expiresAt > op.serverNow &&
    host.store.getUploadChunk(u.uploadId, op.chunkId) !== undefined;
  host.store.transaction(() =>
    storeChunk(
      host.store,
      {
        collection: op.collection,
        chunkId: op.chunkId,
        objectKey: chunkObjectKey(op, op.collection, op.chunkId),
        storedBytes: op.bytes,
        ...(u !== undefined && sealed(u.enc) ? ssecKidOf(host) : {}),
        nowMs: op.serverNow,
      },
      open ? u : undefined,
    ),
  );
  return ok({
    op: "chunkStored",
    outcome: open ? { ok: true } : { ok: false, error: "not_found" },
  });
}

/** The key id of the person's SSE-C key, as a spread member, or nothing. */
function ssecKidOf(host: FileHost): { ssecKid?: string } {
  const kid = host.store.getMeta(SSEC_KID);
  return kid !== undefined ? { ssecKid: kid } : {};
}

/**
 * The read of a chunk (`GET …/files/{collection}/chunks/{chunkId}`): the key and size from this
 * object's rows, and only for a chunk some stored file of the collection references. An id that is
 * unknown, unreferenced (waiting for the collector, or pinned by an upload alone) or another
 * collection's is `not_found`: the answer is the same for all of them.
 */
export function chunkResolve(
  host: FileHost,
  op: Extract<CloudSyncOp, { op: "chunkResolve" }>,
): FileReply {
  host.store.prepare(false);
  const none = ok({
    op: "chunkResolve",
    outcome: { ok: false, error: "not_found" },
  });
  const row = host.store.getChunk(op.collection, op.chunkId);
  if (!row || row.refs <= 0) return none;
  const ssec =
    row.ssecKid !== undefined ? host.store.getSsecKey(row.ssecKid) : undefined;
  if (row.ssecKid !== undefined && !ssec) return none;
  return ok({
    op: "chunkResolve",
    outcome: {
      ok: true,
      key: row.objectKey,
      size: row.storedBytes,
      ...(ssec ? { ssecKey: hexEncode(ssec) } : {}),
    },
  });
}

/**
 * The session a byte request streams against. Only an `open` session takes bytes: one that is
 * finishing, done or ended is `not_found`, and one past its 24 hours is collected here and answers
 * `upload_expired`, exactly as the resume call does.
 */
export async function filePrepare(
  host: FileHost,
  op: Extract<CloudSyncOp, { op: "filePrepare" }>,
): Promise<FileReply> {
  const s = await liveSession(host, op, true);
  const outcome: FilePrepareOutcome =
    "error" in s
      ? { ok: false, error: s.error }
      : {
          ok: true,
          key: fileObjectKey(op, s.u.uploadId),
          mode: s.u.mode,
          size: s.u.size,
          sha256: s.u.sha256,
          partBytes: s.u.partBytes,
          parts:
            s.u.mode === "multipart" && s.u.partBytes !== null
              ? Math.ceil(s.u.size / s.u.partBytes)
              : 1,
          multipartId: s.u.multipartId,
          ...(ssecKeyOf(host, s.u.enc) !== undefined
            ? { ssecKey: ssecKeyOf(host, s.u.enc) as string }
            : {}),
        };
  return ok({ op: "filePrepare", outcome });
}

/**
 * Records part `n` (an `etag`), or forgets it (no `etag`: the bytes did not verify, and R2 may
 * already hold the failed bytes in place of an earlier good part, so the part counts as missing).
 * A session that is no longer open takes nothing.
 */
export function filePart(
  host: FileHost,
  op: Extract<CloudSyncOp, { op: "filePart" }>,
): FileReply {
  host.store.prepare(false);
  const u = sessionOf(host, op);
  const parts =
    u?.mode === "multipart" && u.partBytes !== null
      ? Math.ceil(u.size / u.partBytes)
      : 1;
  if (!u || u.state !== "open" || u.expiresAt <= op.serverNow || op.n > parts)
    return ok({ op: "filePart", outcome: { ok: false, error: "not_found" } });
  host.store.transaction(() => {
    if (op.etag === undefined) host.store.deletePart(u.uploadId, op.n);
    else
      host.store.putPart({
        uploadId: u.uploadId,
        n: op.n,
        etag: op.etag,
        bytes: op.bytes ?? 0,
      });
  });
  return ok({ op: "filePart", outcome: { ok: true } });
}

// ── download and revisions (U-10.8) ──────────────────────────────────────────────────────────

/**
 * The file a download streams: the record's live one, or the kept `version` (live or a revision).
 * A parked file belongs to no live record, and a dead one is waiting to be collected: neither is
 * served. The key comes from the row, never from the request.
 */
export function fileResolve(
  host: FileHost,
  op: Extract<CloudSyncOp, { op: "fileResolve" }>,
): FileReply {
  host.store.prepare(false);
  const row =
    op.version === undefined
      ? host.store.liveFile(op.collection, op.recordId)
      : host.store.getFile(op.collection, op.recordId, op.version);
  if (!row || (row.status !== "live" && row.status !== "revision"))
    return ok({
      op: "fileResolve",
      outcome: { ok: false, error: "not_found" },
    });
  const ssec =
    row.ssecKid !== undefined ? host.store.getSsecKey(row.ssecKid) : undefined;
  // A file under a key the object no longer holds cannot be opened: it is gone, not unreadable.
  if (row.ssecKid !== undefined && !ssec)
    return ok({
      op: "fileResolve",
      outcome: { ok: false, error: "not_found" },
    });
  return ok({
    op: "fileResolve",
    outcome: {
      ok: true,
      file: {
        key: row.objectKey,
        version: row.version,
        size: row.size,
        sha256: row.sha256,
        format: row.format,
        ...(ssec ? { ssecKey: hexEncode(ssec) } : {}),
      },
    },
  });
}

/** The kept older versions of a record's file, newest first. The live file is not one of them. */
export function fileRevisions(
  host: FileHost,
  op: Extract<CloudSyncOp, { op: "fileRevisions" }>,
): FileReply {
  host.store.prepare(false);
  const revisions = host.store
    .filesOf(op.collection, op.recordId)
    .filter((f) => f.status === "revision")
    .sort((a, b) => b.version - a.version)
    .map((f) => ({
      version: f.version,
      size: f.size,
      sha256: f.sha256,
      format: f.format,
      createdAt: f.createdAt,
    }));
  return ok({ op: "fileRevisions", outcome: { ok: true, revisions } });
}

// ── finalize (U-10.7) ────────────────────────────────────────────────────────────────────────

/** The parts a session still lacks, as part numbers. A single upload is one part. */
function missingParts(host: FileHost, u: UploadRow): number[] {
  const need =
    u.mode === "multipart" && u.partBytes !== null
      ? Math.ceil(u.size / u.partBytes)
      : 1;
  const have = new Set(host.store.getParts(u.uploadId).map((p) => p.n));
  const out: number[] = [];
  for (let n = 1; n <= need; n++) if (!have.has(n)) out.push(n);
  return out;
}

/**
 * Takes the object to the state `finalize` hashes it in. A multipart upload is completed in R2
 * (its parts, in order, with the etags the object recorded). A repeat after a crash finds the
 * upload completed already, and the object stands. `absent`: no object is there; `size`: it is not
 * the declared length; `down`: R2 did not answer.
 */
async function sealObject(
  host: FileHost,
  pin: DoPin,
  u: UploadRow,
): Promise<"ok" | "absent" | "size" | "down"> {
  const bucket = host.bucket;
  if (!bucket) return "down";
  const key = fileObjectKey(pin, u.uploadId);
  try {
    if (u.mode === "multipart" && u.multipartId !== null) {
      const parts = host.store
        .getParts(u.uploadId)
        .map((p) => ({ partNumber: p.n, etag: p.etag }));
      try {
        await bucket.resumeMultipartUpload(key, u.multipartId).complete(parts);
      } catch (e) {
        // Completed already (a retry after a crash): the object is what counts.
        if (!(await bucket.head(key))) throw e;
      }
    }
    const head = await bucket.head(key);
    if (head === null) return "absent";
    return head.size === u.size ? "ok" : "size";
  } catch {
    return "down";
  }
}

/**
 * Claims the session for a `finalize` and makes its object ready to hash. A session that already
 * finished answers its stored result (`replay`: idempotent per `uploadId`, nothing is charged
 * twice); one being finished by another call, inside its lease, is `busy`; one with parts missing
 * lists them; an expired one is collected.
 */
export function fileFinalizePrepare(
  host: FileHost,
  op: Extract<CloudSyncOp, { op: "fileFinalizePrepare" }>,
): Promise<FileReply> {
  return host.ctx.blockConcurrencyWhile(async () => {
    host.store.prepare(false);
    const answer = (outcome: FinalizePrepareOutcome) =>
      ok({ op: "fileFinalizePrepare", outcome });
    const u = sessionOf(host, op);
    if (!u || u.state === "aborted")
      return answer({ ok: false, error: "not_found" });
    if (u.state === "done" && u.resultJson !== null)
      return answer({
        ok: true,
        replay: JSON.parse(u.resultJson) as FinalizeResponse,
      });
    if (u.expiresAt <= op.serverNow) {
      await collectExpired(host, op);
      return answer({ ok: false, error: "upload_expired" });
    }
    if (
      u.state === "finalizing" &&
      finalizeLease(u) + FINALIZE_LEASE_MS > op.serverNow
    )
      return answer({ ok: false, busy: true });
    // A delta file: every chunk the plan named must be stored (the ids go back to be sent again),
    // then the manifest, which is part 1.
    const lost =
      u.mode === "chunks" ? missingChunks(host.store, u.uploadId) : [];
    if (lost.length > 0) return answer({ ok: false, missing: lost });
    const missing = missingParts(host, u);
    if (missing.length > 0) return answer({ ok: false, missing });
    const sealed = await sealObject(host, op, u);
    if (sealed === "size") {
      // R2 holds bytes of another length than the upload declared: they can never verify.
      if (!(await discard(host, op, u))) return refuse("unavailable", 503);
      return answer({ ok: false, mismatch: true });
    }
    if (sealed === "absent" && u.mode === "single") {
      // The object is not there, so part 1 is not either.
      host.store.transaction(() => host.store.deletePart(u.uploadId, 1));
      return answer({ ok: false, missing: [1] });
    }
    if (sealed !== "ok") return refuse("unavailable", 503);
    host.store.transaction(() =>
      host.store.putUpload({
        ...u,
        state: "finalizing",
        resultJson: JSON.stringify({ lease: op.serverNow }),
      }),
    );
    return answer({
      ok: true,
      verify: {
        key: fileObjectKey(op, u.uploadId),
        size: u.size,
        sha256: u.sha256,
        mode: u.mode,
        ...(ssecKeyOf(host, u.enc) !== undefined
          ? { ssecKey: ssecKeyOf(host, u.enc) as string }
          : {}),
      },
    });
  });
}

/**
 * The record write. Only a session this call claimed is committed; a refusal (the record changed
 * since `begin`, `maxRecords` reached) ends the upload: its object is deleted and its reservation
 * released, because a new `baseVersion` needs a new `begin`.
 */
export function fileFinalizeCommit(
  host: FileHost,
  op: Extract<CloudSyncOp, { op: "fileFinalizeCommit" }>,
): Promise<FileReply> {
  return host.ctx.blockConcurrencyWhile(async () => {
    host.store.prepare(false);
    const answer = (
      outcome: FinalizeCommitOutcome,
      dirty = false,
    ): FileReply => ({
      ...ok({ op: "fileFinalizeCommit", outcome }),
      ...(dirty ? { dirty } : {}),
    });
    const u = sessionOf(host, op);
    if (!u) return answer({ ok: false, error: "not_found" });
    // Already committed by a call that came first: the same answer.
    if (u.state === "done" && u.resultJson !== null)
      return answer({
        ok: true,
        result: JSON.parse(u.resultJson) as FinalizeResponse,
      });
    if (u.state !== "finalizing")
      return answer({ ok: false, error: "not_found" });
    const out = host.store.transaction(() => {
      const committed = commitFinalize(host.store, {
        upload: u,
        objectKey: fileObjectKey(op, u.uploadId),
        clientId: op.clientId,
        maxRecords: op.maxRecords,
        keepRevisions: op.keepRevisions,
        ...(sealed(u.enc) && host.store.getMeta(SSEC_KID) !== undefined
          ? { ssecKid: host.store.getMeta(SSEC_KID) as string }
          : {}),
        nowMs: op.serverNow,
      });
      if (committed.ok) markDirty(host.store);
      return committed;
    });
    if (out.ok) return answer({ ok: true, result: out.result }, true);
    if (!(await discard(host, op, u))) return refuse("unavailable", 503);
    return answer(out);
  });
}

/** Gives the claim up. `discard`: the bytes did not verify, so the upload ends; else it reopens. */
export function fileFinalizeEnd(
  host: FileHost,
  op: Extract<CloudSyncOp, { op: "fileFinalizeEnd" }>,
): Promise<FileReply> {
  return host.ctx.blockConcurrencyWhile(async () => {
    host.store.prepare(false);
    const u = sessionOf(host, op);
    if (u && u.state === "finalizing") {
      if (op.discard) {
        if (!(await discard(host, op, u))) return refuse("unavailable", 503);
      } else
        host.store.transaction(() =>
          host.store.putUpload({ ...u, state: "open", resultJson: null }),
        );
    }
    return ok({ op: "fileFinalizeEnd", outcome: { ok: true } });
  });
}
