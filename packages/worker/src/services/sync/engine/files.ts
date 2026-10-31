/**
 * Files on records, the engine's half (U-10; WIRE-CONTRACT-V5 §13.8, plans/U-10-U-11a-slices.md
 * §2.3). Pure functions over a `SyncStore`: no R2, no clock of their own, no I/O. The Durable
 * Object makes the R2 control calls around them, and the Worker streams the bytes.
 *
 * This file owns the transfer plan, the checks `begin` makes against stored state, the quota
 * reservation, and the end of a session (release). `finalize` is added by U-10.7.
 */

import {
  SYNC_DELTA_MIN_FILE_BYTES,
  SYNC_FILE_MAX_BYTES,
  SYNC_MAX_OPEN_UPLOADS,
  SYNC_MAX_PARTS,
  SYNC_PART_MAX_BYTES,
  SYNC_PART_MIN_BYTES,
  SYNC_PART_ROUND_BYTES,
  SYNC_SINGLE_PUT_MAX_BYTES,
  SYNC_UPLOAD_TTL_SECONDS,
  type BeginFileRequest,
  type FinalizeResponse,
  type SyncUploadMode,
} from "@polaris-key/protocol/sync";
import { formatHlc } from "./hlc.js";
import { casMismatch } from "./records.js";
import type {
  StoredFile,
  StoredRecord,
  SyncStore,
  UploadRow,
} from "./types.js";
import { accountRecord, fileUsage } from "./usage.js";

// ── The transfer plan (§13.8.1) ──────────────────────────────────────────────────────────────

export type TransferPlan =
  | { mode: "single" }
  | { mode: "multipart"; partBytes: number; parts: number }
  | { mode: "chunks" }
  | { mode: "too_large" };

/**
 * How a file of `size` bytes travels. `delta` is the collection's `files.delta`.
 *
 *   over 1 GiB         `too_large`, whatever the collection
 *   delta, 1 MiB up    `chunks`, never multipart
 *   up to 16 MiB       `single`
 *   over 16 MiB        `multipart`, parts of `max(8 MiB, ceil(size / 9,999) rounded up to 1 MiB)`
 *
 * `sync-vectors.json` `transferPlanCases` pins it (the Worker's test replays every case).
 */
export function syncTransferPlan(size: number, delta: boolean): TransferPlan {
  if (!Number.isSafeInteger(size) || size < 0 || size > SYNC_FILE_MAX_BYTES)
    return { mode: "too_large" };
  if (delta && size >= SYNC_DELTA_MIN_FILE_BYTES) return { mode: "chunks" };
  if (size <= SYNC_SINGLE_PUT_MAX_BYTES) return { mode: "single" };
  const round = SYNC_PART_ROUND_BYTES;
  const wanted = Math.ceil(Math.ceil(size / SYNC_MAX_PARTS) / round) * round;
  const partBytes = Math.min(
    SYNC_PART_MAX_BYTES,
    Math.max(SYNC_PART_MIN_BYTES, wanted),
  );
  return { mode: "multipart", partBytes, parts: Math.ceil(size / partBytes) };
}

/** The R2 key of an upload's object. Only ever built here, from the pin and a session id. */
export const fileObjectKey = (
  pin: { product: string; subject: string },
  uploadId: string,
): string => `u/${pin.product}/${pin.subject}/o/${uploadId}`;

// ── begin (§2.3 checks 5 to 7) ───────────────────────────────────────────────────────────────

/** What the Worker resolved for `begin`, beyond the request (like `PushLimits`). */
export interface FileLimits {
  /** The requesting device's quota in bytes (`0`: reads only). */
  quotaBytes: number;
  productOverCeiling?: boolean;
  usersAtCeiling?: boolean;
}

export interface BeginInput {
  uploadId: string;
  deviceId: string;
  collection: string;
  recordId: string;
  request: BeginFileRequest;
  /** `single` or `multipart` (the chunks mode is U-37). */
  mode: Extract<SyncUploadMode, "single" | "multipart">;
  partBytes: number | null;
  /** The matched declaration's `maxRecords`: a `begin` that would create a record counts against it. */
  maxRecords: number;
  limits: FileLimits;
  nowMs: number;
}

export type BeginRefusal =
  | { ok: false; error: "revision_conflict"; version: number }
  | { ok: false; error: "rate_limited" }
  | {
      ok: false;
      error: "quota_exceeded";
      scope: "user" | "collection" | "product";
    };

export type BeginOutcome = { ok: true; upload: UploadRow } | BeginRefusal;

/** An upload counts as open until it ends or expires. */
export const uploadExpiry = (nowMs: number): number =>
  nowMs + SYNC_UPLOAD_TTL_SECONDS * 1000;

/**
 * Checks 5 to 7 of §2.3, in order, against stored state, and builds the session row. Reads only:
 * `commitBegin` writes. The caller has already swept expired uploads, so the open count and the
 * reservation are the live ones.
 *
 *   5  `baseVersion` against the record (`revision_conflict` carries the server's version; a
 *      record the store holds no row for is version 0, as a push `conflict` says)
 *   6  at most `SYNC_MAX_OPEN_UPLOADS` open sessions (`rate_limited`)
 *   7  the room: a create against `maxRecords`, the product's ceilings, then the person's quota
 *      with what open sessions have reserved (`quota_exceeded`, scope in that order)
 */
export function checkBegin(store: SyncStore, input: BeginInput): BeginOutcome {
  const { request: req, limits } = input;
  const prev = store.getRecord(input.collection, input.recordId);
  if (req.baseVersion !== undefined && casMismatch(prev, req.baseVersion))
    return {
      ok: false,
      error: "revision_conflict",
      version: prev?.version ?? 0,
    };

  if (store.openUploads(input.nowMs).length >= SYNC_MAX_OPEN_UPLOADS)
    return { ok: false, error: "rate_limited" };

  const usage = store.getUsage();
  const reserved = fileUsage(usage).reservedBytes;
  const create = prev === undefined || prev.deleted;
  let scope: "collection" | "product" | "user" | null = null;
  if (create && store.liveRecordCount(input.collection) >= input.maxRecords)
    scope = "collection";
  else if (
    limits.productOverCeiling ||
    (limits.usersAtCeiling && !store.heldData())
  )
    scope = "product";
  else if (
    limits.quotaBytes <= 0 ||
    usage.bytes + reserved + req.size > limits.quotaBytes
  )
    scope = "user";
  if (scope !== null) return { ok: false, error: "quota_exceeded", scope };

  return {
    ok: true,
    upload: {
      uploadId: input.uploadId,
      collection: input.collection,
      recordId: input.recordId,
      baseVersion: req.baseVersion === undefined ? null : req.baseVersion,
      mode: input.mode,
      format: req.format,
      enc: req.enc,
      size: req.size,
      sha256: req.sha256,
      partBytes: input.partBytes,
      multipartId: null,
      reservedBytes: req.size,
      deviceId: input.deviceId,
      createdAt: input.nowMs,
      expiresAt: uploadExpiry(input.nowMs),
      state: "open",
      resultJson: null,
    },
  };
}

/** Stores the session and reserves its bytes. */
export function commitBegin(store: SyncStore, upload: UploadRow): void {
  store.putUpload(upload);
  moveReserved(store, upload.reservedBytes);
}

/** Adds `delta` (may be negative) to the reservation, never below zero. */
export function moveReserved(store: SyncStore, delta: number): void {
  const usage = store.getUsage();
  const next = Math.max(0, fileUsage(usage).reservedBytes + delta);
  store.setUsage({ ...usage, reservedBytes: next });
}

/**
 * Ends a session without a file: releases its reservation exactly once (`reservedBytes` goes to 0
 * on the row, so a repeat releases nothing) and marks it `aborted`. The row stays until its
 * expiry so a repeated `DELETE` is idempotent. A `done` session is left alone: its file is stored.
 */
export function releaseUpload(store: SyncStore, upload: UploadRow): UploadRow {
  if (upload.state === "done") return upload;
  if (upload.reservedBytes > 0) moveReserved(store, -upload.reservedBytes);
  const ended: UploadRow = { ...upload, state: "aborted", reservedBytes: 0 };
  store.putUpload(ended);
  return ended;
}

// ── finalize (§13.8.1, GF2, GF3) ─────────────────────────────────────────────────────────────

/** A session that is finishing holds its claim this long (ms); after it another `finalize` may take over. */
export const FINALIZE_LEASE_MS = 60_000;

/** The claim a `finalizing` session carries in `resultJson`, as epoch ms; 0 for none. */
export function finalizeLease(upload: UploadRow): number {
  if (upload.state !== "finalizing" || upload.resultJson === null) return 0;
  try {
    const lease = (JSON.parse(upload.resultJson) as { lease?: unknown }).lease;
    return typeof lease === "number" ? lease : 0;
  } catch {
    return 0;
  }
}

/**
 * Moves the file counters for a new live file replacing `prev` (which becomes a kept revision) and
 * releases the session's reservation. `bytes` grows by the new file only: the old one was counted
 * already and keeps counting as a revision.
 */
function accountFile(
  store: SyncStore,
  prev: StoredFile | undefined,
  next: StoredFile,
  released: number,
): void {
  const u = store.getUsage();
  const f = fileUsage(u);
  store.setUsage({
    ...u,
    bytes: u.bytes + next.size,
    files: f.files + (prev ? 0 : 1),
    fileBytes: f.fileBytes + next.size - (prev?.size ?? 0),
    revisionBytes: f.revisionBytes + (prev?.size ?? 0),
    reservedBytes: Math.max(0, f.reservedBytes - released),
  });
}

export interface FinalizeInput {
  upload: UploadRow;
  objectKey: string;
  /** The write's clock owner: a clientId-shaped name derived from the device (the file routes carry none). */
  clientId: string;
  maxRecords: number;
  nowMs: number;
}

export type FinalizeCommit =
  | { ok: true; result: FinalizeResponse }
  | { ok: false; error: "revision_conflict"; version: number }
  | { ok: false; error: "quota_exceeded"; scope: "collection" };

/**
 * The commit of a verified upload: a record write (GF2). It re-checks `begin`'s `baseVersion`
 * against the record as it is now (GF3: any write in between is a conflict), takes the next store
 * sequence as the record's `version` and the file's, makes the stored file the live one (the
 * previous live file stays as a revision), charges its bytes and releases the reservation. A
 * create-only `finalize` of a missing record makes a record with no value. The session becomes
 * `done` and keeps the answer, so a repeat of `finalize` replays it and charges nothing.
 *
 * The caller runs this in one transaction and has checked the bytes. A refusal writes nothing.
 */
export function commitFinalize(
  store: SyncStore,
  input: FinalizeInput,
): FinalizeCommit {
  const { upload } = input;
  const prev = store.getRecord(upload.collection, upload.recordId);
  if (upload.baseVersion !== null && casMismatch(prev, upload.baseVersion))
    return {
      ok: false,
      error: "revision_conflict",
      version: prev?.version ?? 0,
    };
  const create = prev === undefined || prev.deleted;
  if (create && store.liveRecordCount(upload.collection) >= input.maxRecords)
    return { ok: false, error: "quota_exceeded", scope: "collection" };

  const version = store.nextSeq();
  // The record keeps its content and its clock: a file is not an HLC-ordered edit of the value.
  const row: StoredRecord =
    prev && !prev.deleted
      ? { ...prev, version }
      : {
          collection: upload.collection,
          id: upload.recordId,
          version,
          stamp: { hlc: formatHlc(input.nowMs, 0), clientId: input.clientId },
          deleted: false,
          kind: "value",
          value: null,
        };
  store.putRecord(row);
  accountRecord(store, prev, row);

  const before = store.liveFile(upload.collection, upload.recordId);
  if (before) store.putFile({ ...before, status: "revision" });
  const file: StoredFile = {
    collection: upload.collection,
    recordId: upload.recordId,
    version,
    objectKey: input.objectKey,
    format: upload.format,
    enc: upload.enc,
    size: upload.size,
    sha256: upload.sha256,
    status: "live",
    createdAt: input.nowMs,
    clientId: input.clientId,
  };
  store.putFile(file);
  accountFile(store, before, file, upload.reservedBytes);

  const result: FinalizeResponse = {
    version,
    size: file.size,
    sha256: file.sha256,
    format: file.format,
  };
  store.putUpload({
    ...upload,
    state: "done",
    reservedBytes: 0,
    resultJson: JSON.stringify(result),
  });
  return { ok: true, result };
}
