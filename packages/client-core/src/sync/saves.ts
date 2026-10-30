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
// U-08 owns the conflict vocabulary; `SaveConflict` here follows the plan's shape (`keep: local |
// remote | both`, `both` only with a free slot of the 16) and is replaced by U-08's when it lands.

import {
  SYNC_FILE_MAX_BYTES,
  SYNC_SAVE_SLOTS,
  type FileRevision,
  type FinalizeResponse,
} from "@polaris-key/protocol/sync";
import type { Json } from "../cloud-sync.js";
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
  ): Promise<SaveSetResult>;
  delete(id: string, baseVersion: number): Promise<SaveSetResult>;
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

/** What a device tried to write when another write got there first. */
export interface SaveConflict {
  id: string;
  /** What this device wrote. */
  local: { metadata: { [k: string]: Json }; size: number };
  /** The server's copy; null when it was deleted meanwhile. */
  remote: SaveSummary | null;
  serverVersion: number | null;
  /** `keep: "both"` needs a free slot of the 16. */
  bothAvailable: boolean;
}

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
  | { state: "conflict"; conflict: SaveConflict };

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
  /** The version the caller last saw; absent is the record's current one, or create-only for a new id. */
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

export class SavesClient {
  private readonly maxBytes: number;
  private readonly spool: SealSpool;

  constructor(private readonly d: SavesDeps) {
    this.maxBytes = d.maxBytes ?? DEFAULT_MAX_BYTES;
    this.spool = d.spool ?? memorySpool;
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
   * metadata is pushed, or on a conflict, a failure or a cancel.
   */
  write(
    id: string,
    bytes: Uint8Array | RangedSource,
    metadata: { [k: string]: Json },
    opts: WriteOptions = {},
  ): SaveTransfer {
    return this.run(id, bytes, metadata, opts, null);
  }

  /**
   * Settle a conflict. `remote` keeps the server's copy and writes nothing; `local` writes this
   * device's save on top of the server's version; `both` writes it as a new save in a free slot.
   */
  resolve(
    conflict: SaveConflict,
    keep: SaveKeep,
    bytes: Uint8Array | RangedSource,
    opts: WriteOptions = {},
  ): SaveTransfer {
    if (keep === "remote") {
      const outcome: SaveOutcome = {
        state: "done",
        id: conflict.id,
        kept: "remote",
        version: conflict.serverVersion,
      };
      return settled(conflict.id, outcome);
    }
    if (keep === "both" && !conflict.bothAvailable)
      return settled(conflict.id, {
        state: "failed",
        error: new SavesError("slots-full"),
      });
    return this.run(
      conflict.id,
      bytes,
      conflict.local.metadata,
      opts,
      keep === "both"
        ? { copy: true }
        : { baseVersion: conflict.serverVersion ?? "*" },
    );
  }

  /** Delete a save; its file is collected with the record. */
  async delete(id: string, baseVersion?: number): Promise<SaveSetResult> {
    this.checkId(id);
    let base = baseVersion;
    if (base === undefined) {
      const rec = await this.d.records.get(id);
      if (rec === null)
        return { ok: false, reason: "rejected", code: "not_found" };
      base = rec.version;
    }
    return this.d.records.delete(id, base);
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
  ): SaveTransfer {
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
        const existing = await this.d.records.get(id);
        if (existing === null) {
          if ((await this.d.records.list()).length >= SYNC_SAVE_SLOTS)
            return { state: "failed", error: new SavesError("slots-full") };
          base = "*";
        } else base = existing.version;
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
          return this.conflictOutcome(id, metadata, source, e.serverVersion);
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
      const set = await this.d.records.set(targetId, value, file.version);
      if (set.ok)
        return {
          state: "done",
          id,
          version: set.version,
          file,
          ...(targetId !== id ? { copyId: targetId } : {}),
        };
      if (set.reason === "conflict")
        return this.conflictOutcome(
          id,
          metadata,
          source,
          set.server?.version ?? null,
          set.server,
        );
      return {
        state: "failed",
        error: new SavesError("rejected", set.code),
      };
    };

    return new WriteTransfer(transferId, progress, attempt, () =>
      this.d.engine.cancel(transferId),
    );
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
    serverVersion: number | undefined | null,
    known?: SaveRecord | null,
  ): Promise<SaveOutcome> {
    const rec = known !== undefined ? known : await this.d.records.get(id);
    const slots = (await this.d.records.list()).length;
    return {
      state: "conflict",
      conflict: {
        id,
        local: { metadata, size: source.size },
        remote: rec ? this.summary(rec) : null,
        serverVersion: rec?.version ?? serverVersion ?? null,
        bothAvailable: slots < SYNC_SAVE_SLOTS,
      },
    };
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
    this.controller.abort();
    this.gate?.();
    await this.done;
  }

  private async drive(): Promise<SaveOutcome> {
    for (;;) {
      this.controller = new AbortController();
      if (this.wanted === "pause") this.controller.abort();
      this.state = "running";
      try {
        const outcome = await this.attempt(this.controller.signal);
        if (this.want() === "cancel") return this.cancelled();
        this.state = outcome.state === "done" ? "done" : outcome.state;
        return outcome;
      } catch (e) {
        if (this.want() === "cancel") return this.cancelled();
        if (!(e instanceof TransferError && e.reason === "aborted")) {
          this.state = "failed";
          return { state: "failed", error: asSavesError(e) };
        }
        // Paused: wait for resume (or cancel).
        this.state = "paused";
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
    this.state = "cancelled";
    return { state: "cancelled" };
  }
}
