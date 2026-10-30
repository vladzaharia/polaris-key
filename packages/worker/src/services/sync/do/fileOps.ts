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
  checkBegin,
  commitBegin,
  fileObjectKey,
  releaseUpload,
} from "../engine/files.js";
import type { SyncStore, UploadRow } from "../engine/types.js";
import type {
  CloudSyncError,
  CloudSyncOp,
  CloudSyncReply,
  DoPin,
  FileStatusOutcome,
} from "./protocol.js";
import type { SqlStore } from "./sqlStore.js";

/** What an operation hands back to `fetch`: a body in the object's protocol and a status. */
export interface FileReply {
  body: CloudSyncReply | CloudSyncError;
  status: number;
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
async function discard(
  host: FileHost,
  pin: DoPin,
  u: UploadRow,
): Promise<boolean> {
  if (u.state === "done" || u.state === "aborted") return true;
  if (!(await dropObjects(host, pin, u))) return false;
  host.store.transaction(() => releaseUpload(host.store, u));
  return true;
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
    if (upload.mode === "multipart") {
      if (!host.bucket) return refuse("unavailable", 503);
      try {
        const created = await host.bucket.createMultipartUpload(
          fileObjectKey(op, upload.uploadId),
        );
        upload.multipartId = created.uploadId;
      } catch {
        return refuse("unavailable", 503);
      }
    }
    host.store.transaction(() => commitBegin(host.store, upload));
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

/** The session, if it is this record's and is still there to be spoken of. */
function sessionOf(
  host: FileHost,
  op: { collection: string; recordId: string; uploadId: string },
): UploadRow | undefined {
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
    ...(u.mode === "multipart" || u.mode === "single"
      ? { received: parts }
      : {}),
    expiresAt: u.expiresAt,
  };
}

export async function fileStatus(
  host: FileHost,
  op: Extract<CloudSyncOp, { op: "fileStatus" }>,
): Promise<FileReply> {
  host.store.prepare(false);
  const u = sessionOf(host, op);
  const answer = (outcome: FileStatusOutcome) =>
    ok({ op: "fileStatus", outcome });
  if (!u || u.state === "aborted")
    return answer({ ok: false, error: "not_found" });
  if (u.expiresAt <= op.serverNow) {
    // Collect it now, and tell the client: it begins again.
    await host.ctx.blockConcurrencyWhile(async () => {
      const again = sessionOf(host, op);
      if (again && (await discard(host, op, again)))
        host.store.transaction(() => host.store.deleteUpload(again.uploadId));
    });
    return answer({ ok: false, error: "upload_expired" });
  }
  return answer({ ok: true, status: statusOf(host, u) });
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
