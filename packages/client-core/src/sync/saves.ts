// Saves on the records store (U-22.3; WIRE-CONTRACT-V5 §13.7, §13.8; plans D-2, D-3, D-8, D-11).
//
// A save is a record of the `saves` collection with one file. The client writes in this order, so
// no save is ever torn:
//
//   1. upload the file (`begin`, bytes, `finalize`), which creates the record or bumps its version
//      and answers it (U-10 A2);
//   2. push the metadata `set` with `baseVersion` = the version `finalize` answered.
//
// In end-to-end mode the sealed metadata carries `"$file": {sha256, size, format}` (D-3). A reader
// downloads the revision whose `sha256` the binding names and fails with `sync-file-invalid` when
// none matches, so a Worker can neither swap the files of two slots nor show a new file under old
// metadata. A record with no binding has no file there, whatever the server attaches to it. In
// server mode there is no binding (the server holds the plaintext), and the metadata is the
// record's own value.
//
// The record layer is a port, `SaveRecords`: the cloud-sync machine binds it (U-22.5), sealing and
// blinding in end-to-end mode (U-22.0). This file owns the order of the steps, the choice of the
// revision, the format check (D-11), the slot cap, conflicts and the `Transfer` handle.
//
// Conflicts (plans/U-08.md §2.4): a write whose base is stale opens one `MergeRequest` per slot
// (S1), and the device keeps its copy unsent until the person or the app answers with `keep`.
// A write with no base is based on the version this device last listed, read or wrote for the
// slot this session (S2); a slot not seen is create-only; a pulled version is never a base. While
// a request is open a write with no base only replaces its local side (S3). Requests live in
// memory (S5): a relaunch drops them and the next write raises the conflict again through S2.

import {
  SYNC_FILE_MAX_BYTES,
  SYNC_SAVE_SLOTS,
  type FileRevision,
  type FinalizeResponse,
} from "@polaris-key/protocol/sync";
import { SYNC_MERGE_CLOSED, type Json } from "../cloud-sync.js";
import {
  MergeRegistry,
  mergeChoiceName,
  type MergeChoice,
  type MergeKeepArg,
  type MergeOutcome,
  type MergeRequest,
  type MergeSide,
  type MergeView,
} from "./merge.js";
import { Sha256 } from "./sha256.js";
import {
  rangedBytes,
  TransferError,
  type ByteSink,
  type FileTransport,
  type RangedSource,
  type TransferEngine,
} from "./transfer.js";
import type { ChunkCache } from "./chunkCache.js";
import type { FileCodec } from "./transferCodec.js";
import { planTransfer } from "./transferPlan.js";

export const SAVES_COLLECTION = "saves";
/** The key of the E2E binding inside a save's sealed metadata (D-3). */
export const SAVE_FILE_BINDING_KEY = "$file";
/** The client code for a downloaded file that fails a check (D-8). */
export const SAVES_FILE_INVALID = "sync-file-invalid";
/** SDK-owned metadata keys, written with every save (SAVES-META): when it was saved (epoch ms) and
 *  the device's display name. A write overwrites an app value under either key; the conflict
 *  screen reads them for its cards. Never a hardware value. */
export const SAVE_SAVED_AT_KEY = "savedAt";
export const SAVE_DEVICE_KEY = "deviceLabel";

const KEY = /^[A-Za-z0-9._:-]{1,128}$/;

export interface SaveFileRef {
  version: number;
  size: number;
  /** Of the stored bytes (ciphertext in E2E mode; for `chunks`, of the stored manifest). */
  sha256: string;
  format: "whole" | "chunks";
}

/** One save record as the records layer holds it: `value` is the opened metadata. */
export interface SaveRecord {
  id: string;
  version: number;
  value: { [k: string]: Json };
  /** The pull's `file` member (U-10 A1); null when the record has no file. */
  file: SaveFileRef | null;
}

export type SaveSetResult =
  | { ok: true; version: number }
  | { ok: false; reason: "conflict"; server: SaveRecord | null }
  | { ok: false; reason: "rejected"; code: string };

export interface SaveRecords {
  /** The record id as it goes on the wire (blinded in E2E mode). */
  wireId(id: string): string | Promise<string>;
  list(): Promise<SaveRecord[]>;
  get(id: string): Promise<SaveRecord | null>;
  /** Push the metadata `set`. `baseVersion` is the version `finalize` answered. */
  set(
    id: string,
    value: { [k: string]: Json },
    baseVersion: number | "*",
    /** Fires when the caller cancels the write: stop waiting and reject with an `aborted`
     *  `TransferError`. A pause does not fire it. There is no timeout: cancel, a sign-out drop and
     *  the host's retries are what end a wait. */
    cancel?: AbortSignal,
    /** The pointer `finalize` returned: an acknowledged set adopts it, so the row lists the new
     *  file at once instead of the prior one (or none). */
    file?: SaveFileRef,
  ): Promise<SaveSetResult>;
  delete(id: string, baseVersion: number): Promise<SaveSetResult>;
  /** Pull the `saves` collection from the server and settle when the pull ended (a failed or
   *  impossible pull settles too, with the cache as it was). Absent: the cache is all there is. */
  pull?(): Promise<void>;
}

export type SavesErrorCode =
  | typeof SAVES_FILE_INVALID
  | "invalid-save"
  | "too-large"
  | "slots-full"
  | "not-found"
  | "transfer-failed"
  | "rejected";

export class SavesError extends Error {
  constructor(
    readonly code: SavesErrorCode,
    readonly detail?: string,
    override readonly cause?: unknown,
  ) {
    super(`saves: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "SavesError";
  }
}

export interface SaveSummary {
  id: string;
  version: number;
  metadata: { [k: string]: Json };
  /** Null when the record has no file (in E2E mode: no binding). */
  file: SaveFileRef | null;
  /** The save's `formatVersion` is above the app's `saveFormatVersion` (D-11). */
  newerFormat: boolean;
}

export type SaveRead =
  | {
      ok: true;
      id: string;
      version: number;
      metadata: { [k: string]: Json };
      file: SaveFileRef | null;
      /** The save's bytes; null when a `sink` took them or the save has no file. */
      bytes: Uint8Array | null;
    }
  | { ok: false; reason: "not-found" }
  | {
      ok: false;
      reason: "newer-format";
      formatVersion: number;
      supported: number;
    };

/** @deprecated Transitional (U-08.3): the pre-MergeRequest shape the Node and React hosts and the
 *  kit still bind to. U-08.4 and the kit slices move them to `MergeRequest` and delete this. */
export interface SaveConflict {
  id: string;
  local: { metadata: { [k: string]: Json }; size: number };
  remote: SaveSummary | null;
  serverVersion: number | null;
  bothAvailable: boolean;
}

/** @deprecated Transitional (U-08.3), see `SaveConflict`. */
export type SaveKeep = "local" | "remote" | "both";

export type TransferState =
  | "running"
  | "paused"
  | "done"
  | "cancelled"
  | "failed"
  | "conflict";

export type SaveOutcome =
  | {
      state: "done";
      id: string;
      /** The record version after the metadata `set`. */
      version: number;
      file: FinalizeResponse;
      /** The id the copy was written under, for `keep: "both"`. */
      copyId?: string;
    }
  | { state: "done"; id: string; kept: "remote"; version: number | null }
  | { state: "cancelled" }
  | { state: "failed"; error: SavesError }
  /** The write was not sent: `request` holds it until `keep` (S1, S3). `conflict` is the
   *  transitional shape (see `SaveConflict`). */
  | { state: "conflict"; request: MergeRequest; conflict: SaveConflict };

/** A write in flight. A cancelled transfer is a state, not an error (D-8). */
export interface SaveTransfer {
  /** The journal key of the transfer. */
  readonly id: string;
  readonly state: TransferState;
  /** Plaintext bytes accounted for and the file's size. */
  readonly progress: { done: number; total: number };
  pause(): void;
  resume(): void;
  cancel(): Promise<void>;
  /** Settles on done, cancelled, failed or conflict; never rejects. */
  readonly done: Promise<SaveOutcome>;
}

export interface WriteOptions {
  /** The version the caller last saw; absent is the version this device last listed, read or wrote
   *  for the slot this session, or create-only (`"*"`) for a slot not seen (S2). */
  baseVersion?: number | "*";
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface ReadOptions {
  /** Takes the bytes instead of returning them; provisional until `read` resolves (discard it on a throw). */
  sink?: ByteSink;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** The stored form of a whole file, held where `upload` can read it again after a pause. */
export interface SealedFile {
  source: RangedSource;
  size: number;
  sha256: string;
}

/** Collects a sealed stream somewhere `upload` can read by range. In memory by default; a host with big saves gives a file. */
export type SealSpool = (
  stored: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
) => Promise<SealedFile>;

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const memorySpool: SealSpool = async (stored) => {
  const hash = new Sha256();
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const piece of stored) {
    hash.update(piece);
    parts.push(Uint8Array.from(piece));
    size += piece.length;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { source: rangedBytes(bytes), size, sha256: toHex(hash.digest()) };
};

export interface SavesDeps {
  records: SaveRecords;
  engine: TransferEngine;
  transport: Pick<FileTransport, "revisions">;
  codec: FileCodec;
  /** The collection's `files.delta`. */
  delta: boolean;
  cache?: ChunkCache;
  /** The collection's `files.maxBytes`; default 32 MiB (the `saves` template). */
  maxBytes?: number;
  /** The app's `saveFormatVersion`; absent turns the check off. */
  saveFormatVersion?: number;
  spool?: SealSpool;
  /** A transfer id unique among the device's transfers. */
  newTransferId?: (saveId: string) => string;
  /** The device's display name, stored with each save (SAVES-META); null or absent stores none. */
  deviceLabel?: () => string | null | undefined;
  /** The clock for `savedAt` (epoch ms); default `Date.now`. */
  now?: () => number;
  /** A write went running, paused or settled: a host that draws the transfers redraws. */
  onState?: () => void;
  /** The client's registry of requests; absent: this client keeps its own (`merge`). */
  merge?: MergeRegistry;
}

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

function splitBinding(value: { [k: string]: Json }): {
  metadata: { [k: string]: Json };
  binding: { sha256: string; size: number; format: "whole" | "chunks" } | null;
} {
  const { [SAVE_FILE_BINDING_KEY]: raw, ...metadata } = value;
  let binding: ReturnType<typeof splitBinding>["binding"] = null;
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const { sha256, size, format } = raw;
    if (
      typeof sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(sha256) &&
      typeof size === "number" &&
      Number.isSafeInteger(size) &&
      size > 0 &&
      (format === "whole" || format === "chunks")
    )
      binding = { sha256, size, format };
  }
  return { metadata, binding };
}

const bindingPresent = (value: { [k: string]: Json }): boolean =>
  SAVE_FILE_BINDING_KEY in value;

const formatOf = (metadata: { [k: string]: Json }): number | null => {
  const v = metadata["formatVersion"];
  return typeof v === "number" && Number.isInteger(v) ? v : null;
};

/** The error a failed transfer is, for the app. */
function asSavesError(e: unknown): SavesError {
  if (e instanceof SavesError) return e;
  if (e instanceof TransferError)
    return e.reason === "file-invalid"
      ? new SavesError(SAVES_FILE_INVALID, e.detail, e)
      : new SavesError("transfer-failed", e.code ?? e.reason, e);
  return new SavesError("transfer-failed", undefined, e);
}

/** One open save request (S1): the device's copy, retained in memory until `keep`. */
interface Slot {
  id: string;
  /** The stamped metadata of the copy. */
  metadata: { [k: string]: Json };
  source: RangedSource;
  opts: WriteOptions;
  /** The version the copy was written on; null: create-only. */
  base: number | null;
  remote: SaveSummary | null;
  /** The server's version for `keep: "local"`; `"*"` when the save is gone. */
  remoteVersion: number | "*";
  slotsFree: boolean;
  /** A keep is running: a conflict it meets reopens the request when the keep ends. */
  keeping: boolean;
  reopen: boolean;
}

const numberOf = (v: Json | undefined): number | null =>
  typeof v === "number" ? v : null;
const stringOf = (v: Json | undefined): string | null =>
  typeof v === "string" ? v : null;

export class SavesClient {
  private readonly maxBytes: number;
  private readonly spool: SealSpool;
  /** The requests of this client's host: the saves layer's are `w:saves/<id>`. */
  readonly merge: MergeRegistry;
  private readonly slots = new Map<string, Slot>();
  /** S2: the version this device last listed, read or wrote for a slot this session. */
  private readonly seen = new Map<string, number>();

  constructor(private readonly d: SavesDeps) {
    this.maxBytes = d.maxBytes ?? DEFAULT_MAX_BYTES;
    this.spool = d.spool ?? memorySpool;
    this.merge = d.merge ?? new MergeRegistry();
  }

  private get e2e(): boolean {
    return this.d.codec.enc === "e2e";
  }

  private summary(rec: SaveRecord): SaveSummary {
    const { metadata, binding } = splitBinding(rec.value);
    const fv = formatOf(metadata);
    const supported = this.d.saveFormatVersion;
    return {
      id: rec.id,
      version: rec.version,
      metadata,
      file: this.e2e ? this.boundFile(rec, binding) : rec.file,
      newerFormat: supported !== undefined && fv !== null && fv > supported,
    };
  }

  /** In E2E mode the file is the one the binding names, and only when the record's current file is it. */
  private boundFile(
    rec: SaveRecord,
    binding: ReturnType<typeof splitBinding>["binding"],
  ): SaveFileRef | null {
    if (binding === null || rec.file === null) return null;
    return rec.file.sha256 === binding.sha256 ? rec.file : null;
  }

  /** The saves of this person, by id. */
  async list(): Promise<SaveSummary[]> {
    const all = await this.d.records.list();
    for (const r of all) this.seen.set(r.id, r.version);
    return all
      .map((r) => this.summary(r))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /** The kept revisions of a save's file, newest first. */
  async revisions(id: string): Promise<FileRevision[]> {
    this.checkId(id);
    const reply = await this.d.transport.revisions(await this.target(id), {});
    if (!reply.ok)
      throw new SavesError(
        reply.status === 404 ? "not-found" : "rejected",
        reply.code,
      );
    return reply.value.revisions;
  }

  /** Read a save: its metadata and bytes. See the header for which revision. */
  async read(id: string, opts: ReadOptions = {}): Promise<SaveRead> {
    this.checkId(id);
    const rec = await this.d.records.get(id);
    if (rec === null) return { ok: false, reason: "not-found" };
    this.seen.set(id, rec.version);
    const { metadata, binding } = splitBinding(rec.value);
    const fv = formatOf(metadata);
    const supported = this.d.saveFormatVersion;
    if (supported !== undefined && fv !== null && fv > supported)
      return {
        ok: false,
        reason: "newer-format",
        formatVersion: fv,
        supported,
      };

    let ref: SaveFileRef | null;
    if (this.e2e) {
      if (binding === null) {
        // A malformed binding is not an absent one: the writer meant a file.
        if (bindingPresent(rec.value))
          throw new SavesError(SAVES_FILE_INVALID, "binding");
        ref = null;
      } else ref = await this.revisionFor(id, rec, binding);
    } else ref = rec.file;
    if (ref === null)
      return {
        ok: true,
        id,
        version: rec.version,
        metadata,
        file: null,
        bytes: null,
      };

    const parts: Uint8Array[] = [];
    const sink: ByteSink = opts.sink ?? {
      write: async (b) => {
        parts.push(Uint8Array.from(b));
      },
    };
    try {
      await this.d.engine.download({
        collection: SAVES_COLLECTION,
        record: await this.d.records.wireId(id),
        version: ref.version,
        format: ref.format,
        size: ref.size,
        sha256: ref.sha256,
        codec: this.d.codec,
        ...(this.d.cache ? { cache: this.d.cache } : {}),
        sink,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      throw asSavesError(e);
    }
    return {
      ok: true,
      id,
      version: rec.version,
      metadata,
      file: ref,
      bytes: opts.sink ? null : concat(parts),
    };
  }

  /** D-3: the revision the binding names, else a failure. */
  private async revisionFor(
    id: string,
    rec: SaveRecord,
    binding: NonNullable<ReturnType<typeof splitBinding>["binding"]>,
  ): Promise<SaveFileRef> {
    const fits = (r: {
      size: number;
      sha256: string;
      format: "whole" | "chunks";
    }) =>
      r.sha256 === binding.sha256 &&
      r.size === binding.size &&
      r.format === binding.format;
    if (rec.file !== null && fits(rec.file)) return rec.file;
    const found = (await this.revisions(id)).find(fits);
    if (!found) throw new SavesError(SAVES_FILE_INVALID, "binding");
    return {
      version: found.version,
      size: found.size,
      sha256: found.sha256,
      format: found.format,
    };
  }

  /**
   * Write a save. Resolves at once with a handle; `done` settles when the file is stored and the
   * metadata is pushed, or on a conflict, a failure or a cancel. While a request is open for the
   * slot, a write with no base only replaces the request's local copy and settles `conflict`;
   * a write with a base supersedes the request (S3).
   */
  write(
    id: string,
    bytes: Uint8Array | RangedSource,
    metadata: { [k: string]: Json },
    opts: WriteOptions = {},
  ): SaveTransfer {
    const slot = this.slots.get(id);
    if (slot) {
      if (opts.baseVersion !== undefined) this.closeSlot(id, "superseded");
      else {
        const source = "read" in bytes ? bytes : rangedBytes(bytes);
        const stamped = this.stamped(metadata);
        const check = this.precheck(id, source, stamped);
        if (check) return settled(id, { state: "failed", error: check });
        slot.metadata = stamped;
        slot.source = source;
        slot.opts = opts;
        this.merge.update(this.requestId(id), {
          local: this.localSide(slot),
        });
        return settled(id, {
          state: "conflict",
          request: this.merge.find(this.requestId(id))!,
          conflict: {
            id,
            local: { metadata: slot.metadata, size: source.size },
            remote: slot.remote,
            serverVersion: slot.remote?.version ?? null,
            bothAvailable: slot.slotsFree && slot.remote !== null,
          },
        });
      }
    }
    return this.run(id, bytes, metadata, opts, null);
  }

  /** @deprecated Transitional (U-08.3): use `MergeRequest.keep`. The bytes are the caller's. */
  resolve(
    conflict: SaveConflict,
    keep: SaveKeep,
    bytes: Uint8Array | RangedSource,
    opts: WriteOptions = {},
  ): SaveTransfer {
    const id = conflict.id;
    if (keep === "remote")
      return deferred(id, async () => {
        await this.pull();
        const rec = await this.d.records.get(id);
        if (rec) this.seen.set(id, rec.version);
        this.closeSlot(id, "remote");
        return {
          state: "done",
          id,
          kept: "remote",
          version: rec?.version ?? null,
        } satisfies SaveOutcome;
      });
    if (keep === "both" && !conflict.bothAvailable)
      return settled(id, {
        state: "failed",
        error: new SavesError("slots-full"),
      });
    const t = this.run(
      id,
      bytes,
      conflict.local.metadata,
      opts,
      keep === "both"
        ? { copy: true }
        : {
            baseVersion:
              conflict.remote === null || !conflict.serverVersion
                ? "*"
                : conflict.serverVersion,
          },
      false,
    );
    void t.done.then((o) => {
      if (o.state === "done") this.closeSlot(id, keep);
    });
    return t;
  }

  /** Delete a save; its file is collected with the record. With a request open for the slot the
   *  default base is the request's, so a delete that conflicts keeps the other copy (S3). */
  async delete(id: string, baseVersion?: number): Promise<SaveSetResult> {
    this.checkId(id);
    const slot = this.slots.get(id);
    let base = baseVersion;
    if (base === undefined) {
      if (slot) {
        if (slot.base === null) {
          const server = await this.d.records.get(id);
          this.closeSlot(id, "superseded");
          return { ok: false, reason: "conflict", server };
        }
        base = slot.base;
      } else {
        const rec = await this.d.records.get(id);
        if (rec === null)
          return { ok: false, reason: "rejected", code: "not_found" };
        base = rec.version;
      }
    }
    const r = await this.d.records.delete(id, base);
    if (
      slot &&
      this.slots.get(id) === slot &&
      (r.ok || r.reason === "conflict")
    )
      this.closeSlot(id, "superseded");
    if (r.ok) this.seen.delete(id);
    return r;
  }

  // ── internals ─────────────────────────────────────────────────────────────────────────────

  private checkId(id: string): void {
    if (!KEY.test(id)) throw new SavesError("invalid-save", "id");
  }

  private async target(id: string) {
    return {
      collection: SAVES_COLLECTION,
      record: await this.d.records.wireId(id),
    };
  }

  private run(
    id: string,
    bytes: Uint8Array | RangedSource,
    metadata: { [k: string]: Json },
    opts: WriteOptions,
    mode: { baseVersion: number | "*" } | { copy: true } | null,
    stamp = true,
  ): SaveTransfer {
    // The SDK's own keys: when and where this save was written. A keep re-runs the write with the
    // stamps of the copy it holds (`stamp` false).
    if (stamp) metadata = this.stamped(metadata);
    const hard = new AbortController();
    const source = "read" in bytes ? bytes : rangedBytes(bytes);
    const transferId = (this.d.newTransferId ?? ((s) => `saves:${s}`))(id);
    let sealed: Promise<SealedFile> | null = null;
    const progress = { done: 0, total: source.size };

    const attempt = async (signal: AbortSignal): Promise<SaveOutcome> => {
      const check = this.precheck(id, source, metadata);
      if (check) return { state: "failed", error: check };
      let targetId = id;
      let base: number | "*" | undefined;
      if (mode !== null && "copy" in mode) {
        const free = await this.freeId(id);
        if (free === null)
          return { state: "failed", error: new SavesError("slots-full") };
        targetId = free;
        base = "*";
      } else if (mode !== null) base = mode.baseVersion;
      else if (opts.baseVersion !== undefined) base = opts.baseVersion;
      else {
        // S2: the version this device saw this session; else create-only. A pulled version is
        // never a base, so another device's newer save is a conflict, not an overwrite.
        const seen = this.seen.get(id);
        if (seen !== undefined) base = seen;
        else {
          if (
            (await this.d.records.get(id)) === null &&
            (await this.d.records.list()).length >= SYNC_SAVE_SLOTS
          )
            return { state: "failed", error: new SavesError("slots-full") };
          base = "*";
        }
      }
      const wire = await this.d.records.wireId(targetId);
      const onProgress = (done: number, total: number) => {
        progress.done = done;
        progress.total = total;
        opts.onProgress?.(done, total);
      };
      const common = {
        id: transferId,
        collection: SAVES_COLLECTION,
        record: wire,
        ...(base !== undefined ? { baseVersion: base } : {}),
        onProgress,
        signal,
      };
      let file: FinalizeResponse;
      try {
        const stored = this.d.codec.storedSize(source.size);
        const plan = planTransfer(stored, this.d.delta);
        if (plan.mode === "too_large")
          return { state: "failed", error: new SavesError("too-large") };
        if (plan.mode === "chunks")
          file = await this.d.engine.uploadChunked({
            ...common,
            source,
            codec: this.d.codec,
          });
        else {
          sealed ??= this.seal(source, signal);
          const s = await sealed;
          file = await this.d.engine.upload({
            ...common,
            source: s.source,
            size: s.size,
            sha256: s.sha256,
            enc: this.d.codec.enc,
          });
        }
      } catch (e) {
        if (e instanceof TransferError && e.reason === "conflict")
          return this.conflictOutcome(
            id,
            metadata,
            source,
            opts,
            base,
            e.serverVersion,
          );
        if (e instanceof TransferError && e.reason === "aborted") throw e;
        return { state: "failed", error: asSavesError(e) };
      }
      const value: { [k: string]: Json } = {
        ...metadata,
        ...(this.e2e
          ? {
              [SAVE_FILE_BINDING_KEY]: {
                sha256: file.sha256,
                size: file.size,
                format: file.format,
              },
            }
          : {}),
      };
      const set = await this.d.records.set(
        targetId,
        value,
        file.version,
        hard.signal,
        {
          version: file.version,
          size: file.size,
          sha256: file.sha256,
          format: file.format,
        },
      );
      if (set.ok) {
        this.seen.set(targetId, set.version);
        return {
          state: "done",
          id,
          version: set.version,
          file,
          ...(targetId !== id ? { copyId: targetId } : {}),
        };
      }
      if (set.reason === "conflict")
        return this.conflictOutcome(
          id,
          metadata,
          source,
          opts,
          base,
          set.server?.version ?? null,
          set.server,
        );
      return {
        state: "failed",
        error: new SavesError("rejected", set.code),
      };
    };

    return new WriteTransfer(
      transferId,
      progress,
      attempt,
      () => this.d.engine.cancel(transferId),
      () => hard.abort(),
      this.d.onState,
    );
  }

  private stamped(metadata: { [k: string]: Json }): { [k: string]: Json } {
    const {
      [SAVE_SAVED_AT_KEY]: _at,
      [SAVE_DEVICE_KEY]: _dev,
      ...rest
    } = metadata;
    const label = this.d.deviceLabel?.();
    return {
      ...rest,
      [SAVE_SAVED_AT_KEY]: (this.d.now ?? Date.now)(),
      ...(label ? { [SAVE_DEVICE_KEY]: label } : {}),
    };
  }

  /** Pull the collection; never throws. True when the records layer pulled. */
  private async pull(): Promise<boolean> {
    if (!this.d.records.pull) return false;
    try {
      await this.d.records.pull();
      return true;
    } catch {
      return false;
    }
  }

  private precheck(
    id: string,
    source: RangedSource,
    metadata: { [k: string]: Json },
  ): SavesError | null {
    if (!KEY.test(id)) return new SavesError("invalid-save", "id");
    if (SAVE_FILE_BINDING_KEY in metadata)
      return new SavesError("invalid-save", "reserved-key");
    if (source.size > this.maxBytes || source.size > SYNC_FILE_MAX_BYTES)
      return new SavesError("too-large");
    return null;
  }

  private async seal(
    source: RangedSource,
    signal: AbortSignal,
  ): Promise<SealedFile> {
    const plain = (async function* () {
      for (let at = 0; at < source.size; at += 1_048_576)
        yield await source.read(
          at,
          Math.min(source.size, at + 1_048_576),
          signal,
        );
    })();
    return this.spool(this.d.codec.sealStream(plain), signal);
  }

  /** The first `<id>.copy`, `<id>.copy2`, ... that is not a save; null when all 16 slots are in use. */
  private async freeId(id: string): Promise<string | null> {
    const all = await this.d.records.list();
    if (all.length >= SYNC_SAVE_SLOTS) return null;
    const taken = new Set(all.map((r) => r.id));
    for (let n = 1; n < 1000; n++) {
      const cand = `${id.slice(0, 120)}.copy${n === 1 ? "" : n}`;
      if (!taken.has(cand)) return cand;
    }
    return null;
  }

  private async conflictOutcome(
    id: string,
    metadata: { [k: string]: Json },
    source: RangedSource,
    opts: WriteOptions,
    base: number | "*" | undefined,
    serverVersion: number | undefined | null,
    known?: SaveRecord | null,
  ): Promise<SaveOutcome> {
    // The cache may be behind the conflict: pull before reading it, so the screen shows what the
    // server holds (and a save deleted elsewhere reads as deleted).
    const pulled = await this.pull();
    const slots = (await this.d.records.list()).length;
    // The server's answer wins. `known` is the copy a rejected `set` carried (null: deleted). A
    // file `begin` answers only a version, and the cached row stands in for it only while it is
    // that very version; a stale row is never presented as the server's copy.
    let remote: SaveSummary | null;
    let version: number | null;
    if (known !== undefined) {
      remote = known ? this.summary(known) : null;
      version = known?.version ?? serverVersion ?? null;
    } else if (serverVersion === undefined || serverVersion === null) {
      const rec = await this.d.records.get(id);
      remote = rec ? this.summary(rec) : null;
      version = rec?.version ?? null;
    } else if (serverVersion === 0) {
      remote = null;
      version = 0;
    } else {
      const rec = await this.d.records.get(id);
      if (rec && rec.version >= serverVersion) {
        remote = this.summary(rec);
        version = rec.version;
      } else if (pulled && rec === null) {
        // Pulled and gone: a tombstone's version, not a copy.
        remote = null;
        version = null;
      } else {
        remote = {
          id,
          version: serverVersion,
          metadata: {},
          file: null,
          newerFormat: false,
        };
        version = serverVersion;
      }
    }
    const slot0: SaveConflict = {
      id,
      local: { metadata, size: source.size },
      remote,
      serverVersion: version,
      bothAvailable: slots < SYNC_SAVE_SLOTS,
    };
    const request = this.openSlot(
      {
        id,
        metadata,
        source,
        opts,
        base: typeof base === "number" ? base : null,
        remote,
        remoteVersion: !remote || !version ? "*" : version,
        slotsFree: slots < SYNC_SAVE_SLOTS,
      },
      version,
    );
    return { state: "conflict", request, conflict: slot0 };
  }

  // ── requests (S1, S3, S4) ─────────────────────────────────────────────────────────────────

  private requestId(id: string): string {
    return `w:${SAVES_COLLECTION}/${id}`;
  }

  private localSide(slot: Slot): MergeSide {
    const plan = planTransfer(
      this.d.codec.storedSize(slot.source.size),
      this.d.delta,
    );
    return {
      value: slot.metadata,
      version: slot.base,
      savedAt: numberOf(slot.metadata[SAVE_SAVED_AT_KEY]),
      device: stringOf(slot.metadata[SAVE_DEVICE_KEY]),
      file: {
        size: slot.source.size,
        format: plan.mode === "chunks" ? "chunks" : "whole",
      },
    };
  }

  private remoteSide(slot: Slot, version: number | null): MergeSide | null {
    const r = slot.remote;
    if (r === null) return null;
    return {
      value: r.metadata,
      version: version ?? r.version,
      savedAt: numberOf(r.metadata[SAVE_SAVED_AT_KEY]),
      device: stringOf(r.metadata[SAVE_DEVICE_KEY]),
      file: r.file ? { size: r.file.size, format: r.file.format } : null,
    };
  }

  private view(
    slot: Slot,
    version: number | null,
    state: "open" | "applying",
    error: string | null,
  ): MergeView {
    const choices: MergeChoice[] = ["local", "remote"];
    if (slot.remote !== null && slot.slotsFree) choices.push("both");
    return {
      id: this.requestId(slot.id),
      cause: "write",
      collection: SAVES_COLLECTION,
      record: slot.id,
      local: this.localSide(slot),
      remote: this.remoteSide(slot, version),
      choices,
      state,
      error,
    };
  }

  /** S1: open the slot's request, or (a keep conflicted again) bring the open one up to date. */
  private openSlot(
    init: Omit<Slot, "keeping" | "reopen">,
    version: number | null,
  ): MergeRequest {
    const have = this.slots.get(init.id);
    const slot: Slot = have
      ? Object.assign(have, init, { reopen: have.keeping })
      : { ...init, keeping: false, reopen: false };
    this.slots.set(init.id, slot);
    const view = this.view(
      slot,
      version,
      slot.keeping ? "applying" : "open",
      null,
    );
    if (slot.keeping) {
      // The keep ends first; `keepSlot` reopens the request for the person.
      this.merge.update(init.id, view);
      return this.merge.find(view.id)!;
    }
    return this.merge.open(view, {
      keep: (choice) => this.keepSlot(init.id, choice),
    });
  }

  private closeSlot(id: string, how: MergeChoice | "superseded"): void {
    this.slots.delete(id);
    this.merge.close(this.requestId(id), how);
  }

  /** S4: answer the slot's request; the transfer's outcome settles the promise. */
  private async keepSlot(
    id: string,
    choice: MergeKeepArg,
  ): Promise<MergeOutcome> {
    const slot = this.slots.get(id);
    const rid = this.requestId(id);
    if (!slot) return { ok: false, code: SYNC_MERGE_CLOSED, reopened: false };
    const name = mergeChoiceName(choice);
    slot.keeping = true;
    slot.reopen = false;
    this.merge.update(rid, { state: "applying", error: null });
    const reopen = (code: string): MergeOutcome => {
      slot.keeping = false;
      const again = slot.reopen;
      slot.reopen = false;
      this.merge.update(rid, {
        ...this.view(
          slot,
          slot.remote?.version ?? null,
          "open",
          again ? null : code,
        ),
      });
      if (again) this.merge.reannounce(rid);
      return { ok: false, code: again ? "conflict" : code, reopened: true };
    };
    if (name === "remote") {
      // Pull first, so the cache holds the copy the person chose (not this device's old one).
      await this.pull();
      const rec = await this.d.records.get(id);
      if (rec) this.seen.set(id, rec.version);
      this.closeSlot(id, "remote");
      return { ok: true, kept: "remote", version: rec?.version ?? null };
    }
    if (name === "both" && !slot.slotsFree) return reopen("slots-full");
    const out = await this.run(
      id,
      slot.source,
      slot.metadata,
      slot.opts,
      name === "both" ? { copy: true } : { baseVersion: slot.remoteVersion },
      false,
    ).done;
    if (out.state === "done" && !("kept" in out)) {
      this.closeSlot(id, name as MergeChoice);
      return {
        ok: true,
        kept: name as MergeChoice,
        version: out.version,
        ...(out.copyId !== undefined ? { copyId: out.copyId } : {}),
      };
    }
    if (out.state === "conflict") return reopen("conflict");
    return reopen(out.state === "failed" ? out.error.code : "cancelled");
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A transfer that has no file to move: it settles when `run` does. */
function deferred(id: string, run: () => Promise<SaveOutcome>): SaveTransfer {
  let state: TransferState = "running";
  const done = run().then(
    (o) => {
      state = o.state === "done" ? "done" : o.state;
      return o;
    },
    (e): SaveOutcome => {
      state = "failed";
      return { state: "failed", error: asSavesError(e) };
    },
  );
  return {
    id,
    get state() {
      return state;
    },
    progress: { done: 0, total: 0 },
    pause() {},
    resume() {},
    cancel: async () => {},
    done,
  };
}

function settled(id: string, outcome: SaveOutcome): SaveTransfer {
  return {
    id,
    state: outcome.state === "done" ? "done" : outcome.state,
    progress: { done: 0, total: 0 },
    pause() {},
    resume() {},
    cancel: async () => {},
    done: Promise.resolve(outcome),
  };
}

type Wanted = "run" | "pause" | "cancel";

/** Drives one write: pause stops the engine and keeps the journal, resume runs it again, cancel releases the server's upload. */
class WriteTransfer implements SaveTransfer {
  state: TransferState = "running";
  readonly done: Promise<SaveOutcome>;
  private controller = new AbortController();
  private wanted: Wanted = "run";
  private gate: (() => void) | null = null;

  constructor(
    readonly id: string,
    readonly progress: { done: number; total: number },
    private readonly attempt: (signal: AbortSignal) => Promise<SaveOutcome>,
    private readonly release: () => Promise<void>,
    private readonly onCancel: () => void = () => undefined,
    private readonly onState: () => void = () => undefined,
  ) {
    this.done = this.drive();
  }

  pause(): void {
    if (this.state !== "running") return;
    this.wanted = "pause";
    this.controller.abort();
  }

  resume(): void {
    if (this.state !== "paused" && this.wanted !== "pause") return;
    this.wanted = "run";
    this.gate?.();
  }

  async cancel(): Promise<void> {
    if (this.state === "done" || this.state === "failed") return;
    this.wanted = "cancel";
    this.onCancel();
    this.controller.abort();
    this.gate?.();
    await this.done;
  }

  private async drive(): Promise<SaveOutcome> {
    for (;;) {
      this.controller = new AbortController();
      if (this.wanted === "pause") this.controller.abort();
      this.setState("running");
      try {
        const outcome = await this.attempt(this.controller.signal);
        if (this.want() === "cancel") return this.cancelled();
        this.setState(outcome.state === "done" ? "done" : outcome.state);
        return outcome;
      } catch (e) {
        if (this.want() === "cancel") return this.cancelled();
        if (!(e instanceof TransferError && e.reason === "aborted")) {
          this.setState("failed");
          return { state: "failed", error: asSavesError(e) };
        }
        // Paused: wait for resume (or cancel).
        this.setState("paused");
        await new Promise<void>((resolve) => {
          this.gate = resolve;
          if (this.want() !== "pause") resolve();
        });
        this.gate = null;
        if (this.want() === "cancel") return this.cancelled();
        this.wanted = "run";
      }
    }
  }

  private setState(next: TransferState): void {
    if (this.state === next) return;
    this.state = next;
    try {
      this.onState();
    } catch {
      // A listener's failure is its own.
    }
  }

  /** The field, read afresh: it changes across every await. */
  private want(): Wanted {
    return this.wanted;
  }

  private async cancelled(): Promise<SaveOutcome> {
    try {
      await this.release();
    } catch {
      // The server expires the upload within the day.
    }
    this.setState("cancelled");
    return { state: "cancelled" };
  }
}
