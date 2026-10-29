// The Cloud Sync file transfer engine, part I (U-22.1; WIRE-CONTRACT-V5 §13.8): upload in modes
// `single` and `multipart`. Part II (U-22.2) adds `chunks` and downloads.
//
// The engine owns the order of calls and the recovery rules, and nothing else. Three ports keep it
// pure: a `FileTransport` (the routes of §13.8, typed; a host maps them to HTTP and never lets a
// server-chosen path through), a `JournalStore` (what survives a kill) and a `RangedSource` (the
// stored bytes, read by range, so a part is read when it is sent and never held longer).
//
//   begin -> parts, at most 4 at once and in any order -> finalize
//
//   resume     a journal record for the same transfer id, bytes and record is resumed: the server's
//              `received` list is the truth, so a part the journal calls done but the server lost is
//              sent again. A record past `expiresAt`, or one for other bytes, is dropped and the
//              upload begins afresh.
//   429, 5xx   wait and retry. `Retry-After` is honoured and holds every part, not just the one
//   or no      that was told; without it the wait doubles from 0.5 s to 30 s, with jitter.
//   answer
//   410        the upload expired or is gone: forget it and begin again (a few times, then fail).
//   409        surfaced as a `TransferError` (`conflict`): a stale `baseVersion` carries the
//              server's version. The upload is aborted; nothing is retried.
//   400        `upload_mismatch` is surfaced (`mismatch`); no retry can fix the bytes.
//
// The bytes must be what `sha256` and `size` say: the source is hashed before `begin`, and a source
// that disagrees is refused (`source-mismatch`) with nothing sent. In E2E mode the caller seals
// first, so these are the ciphertext's.

import type {
  BeginFileRequest,
  BeginFileResponse,
  FinalizeRequest,
  FinalizeResponse,
  SyncFileEnc,
  UploadStatus,
} from "@polaris-key/protocol/sync";
import {
  SYNC_MAX_PARTS,
  SYNC_PART_MAX_BYTES,
  SYNC_SINGLE_PUT_MAX_BYTES,
} from "@polaris-key/protocol/sync";
import { webCryptoSyncPort } from "./crypto.js";
import { Sha256 } from "./sha256.js";
import { partRange } from "./transferPlan.js";
import {
  parseJournalRecord,
  TRANSFER_JOURNAL_VERSION,
  TransferJournalError,
  type JournalStore,
  type TransferJournalRecord,
} from "./transferJournal.js";

/** §13.8.1: at most 4 parts in flight. */
export const TRANSFER_MAX_PARALLEL_PARTS = 4;

/** The stored bytes of one file, read by half-open range. `size` is fixed for the life of the source. */
export interface RangedSource {
  readonly size: number;
  read(start: number, end: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/** A source over bytes already in memory. */
export function rangedBytes(bytes: Uint8Array): RangedSource {
  return {
    size: bytes.length,
    read: async (start, end) => bytes.subarray(start, end),
  };
}

/** Which file a call is about: `record` is the wire id (blinded in E2E mode). */
export interface FileTarget {
  collection: string;
  record: string;
}

/** The answer to a route call. A refusal is a value; a call that gets no answer at all (the network, a timeout) throws, and the engine retries it. */
export type FileReply<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: number;
      /** The server's `error.code`. */
      code: string;
      retryAfterSeconds?: number;
      /** The error body's extra members: `{missing}` on `upload_incomplete`, `{server:{version}}` on `revision_conflict`. */
      body?: unknown;
    };

export interface FileCallOptions {
  signal?: AbortSignal;
}

/** The upload routes of §13.8 under `/<p>/sync/files/{collection}/{id}`. `sha256` is the lowercase hex of the body; a host sends it as `Content-Digest`. */
export interface FileTransport {
  begin(
    target: FileTarget,
    request: BeginFileRequest,
    options: FileCallOptions,
  ): Promise<FileReply<BeginFileResponse>>;
  /** `GET …/upload/{uploadId}`. */
  status(
    target: FileTarget,
    uploadId: string,
    options: FileCallOptions,
  ): Promise<FileReply<UploadStatus>>;
  /** `PUT …/upload/{uploadId}`: the whole body of a `single` upload. */
  putSingle(
    target: FileTarget,
    uploadId: string,
    body: Uint8Array,
    sha256: string,
    options: FileCallOptions,
  ): Promise<FileReply<null>>;
  /** `PUT …/upload/{uploadId}/parts/{n}`, n from 1. */
  putPart(
    target: FileTarget,
    uploadId: string,
    n: number,
    body: Uint8Array,
    sha256: string,
    options: FileCallOptions,
  ): Promise<FileReply<null>>;
  /** `DELETE …/upload/{uploadId}`. */
  abort(
    target: FileTarget,
    uploadId: string,
    options: FileCallOptions,
  ): Promise<FileReply<null>>;
  /** `POST …/finalize`. */
  finalize(
    target: FileTarget,
    request: FinalizeRequest,
    options: FileCallOptions,
  ): Promise<FileReply<FinalizeResponse>>;
}

export type TransferFailure =
  /** The source's size or hash is not what the caller declared. Nothing was sent. */
  | "source-mismatch"
  /** The journal record has a `v` this build does not know. It is left as found. */
  | "journal-version"
  /** The journal record is malformed. It is left as found. */
  | "journal-malformed"
  /** A 409: `revision_conflict` (`serverVersion` set) or another. */
  | "conflict"
  /** `400 upload_mismatch`: the server holds other bytes than were declared. */
  | "mismatch"
  /** Any other refusal (401, 403, 413, 429 on `begin` with no retries left, …): `status` and `code` say which. */
  | "rejected"
  /** The server answered with a mode or part size this engine cannot use. */
  | "bad-reply"
  /** Retries ran out; the journal keeps the progress for a later `upload`. */
  | "retries-exhausted"
  /** The upload kept expiring or vanishing. */
  | "restarts-exhausted"
  /** The signal fired; the journal keeps the progress. */
  | "aborted";

export class TransferError extends Error {
  readonly status?: number;
  readonly code?: string;
  /** On a `revision_conflict`: the server's current version. */
  readonly serverVersion?: number;
  constructor(
    readonly reason: TransferFailure,
    details: { status?: number; code?: string; serverVersion?: number } = {},
  ) {
    super(
      `file transfer: ${reason}${details.code ? ` (${details.code})` : ""}`,
    );
    this.name = "TransferError";
    if (details.status !== undefined) this.status = details.status;
    if (details.code !== undefined) this.code = details.code;
    if (details.serverVersion !== undefined)
      this.serverVersion = details.serverVersion;
  }
}

export interface TransferEngineDeps {
  transport: FileTransport;
  journal: JournalStore;
  /** Milliseconds since the epoch. */
  now?: () => number;
  /** Wait `ms`; rejects when the signal fires. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** In [0, 1), for backoff jitter. */
  random?: () => number;
  /** SHA-256 of a part. */
  sha256?: (data: Uint8Array) => Promise<Uint8Array>;
  /** Attempts per request before `retries-exhausted`. Default 8. */
  maxAttempts?: number;
  /** Begins afresh this many times after a 410. Default 3. */
  maxRestarts?: number;
  /** Longest wait taken from a `Retry-After`, in seconds. Default 900. */
  maxRetryAfterSeconds?: number;
}

export interface UploadRequest {
  /** Stable per intended write; the journal key. A rerun with the same id resumes. */
  id: string;
  collection: string;
  /** The wire record id. */
  record: string;
  source: RangedSource;
  /** The stored size, `source.size`. */
  size: number;
  /** Lowercase hex SHA-256 of the stored bytes. */
  sha256: string;
  enc: SyncFileEnc;
  baseVersion?: number | "*";
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}

const HASH_SLICE = 1_048_576;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new TransferError("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new TransferError("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Thrown inside a run to start the upload over. */
class Restart extends Error {}

export class TransferEngine {
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly hash: (data: Uint8Array) => Promise<Uint8Array>;
  private readonly maxAttempts: number;
  private readonly maxRestarts: number;
  private readonly maxRetryAfterMs: number;

  constructor(private readonly deps: TransferEngineDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.hash = deps.sha256 ?? webCryptoSyncPort.sha256;
    this.maxAttempts = deps.maxAttempts ?? 8;
    this.maxRestarts = deps.maxRestarts ?? 3;
    this.maxRetryAfterMs = (deps.maxRetryAfterSeconds ?? 900) * 1000;
    this.io = {
      deps,
      hash: (d) => this.hash(d),
      abortQuietly: (t, uploadId) => this.abortQuietly(t, uploadId),
      call: (hold, signal, fn) => this.call(hold, signal, fn),
    };
  }

  /** Upload one file and finalize it. Resolves with the `finalize` answer; the journal record is gone by then. */
  async upload(req: UploadRequest): Promise<FinalizeResponse> {
    if (req.source.size !== req.size)
      throw new TransferError("source-mismatch");
    await this.verifySource(req);
    // Read before anything is sent: an unreadable record stops the transfer untouched.
    let resume = await this.loadRecord(req);
    for (let restarts = 0; ; restarts++) {
      try {
        return await new Run(this, req, resume).go();
      } catch (e) {
        if (!(e instanceof Restart)) throw e;
        if (restarts >= this.maxRestarts)
          throw new TransferError("restarts-exhausted", { status: 410 });
        await this.deps.journal.delete(req.id);
        resume = null;
      }
    }
  }

  /** Drop a transfer: abort the server's upload (best effort) and forget the record. */
  async cancel(id: string): Promise<void> {
    const raw = await this.deps.journal.get(id);
    if (raw === null) return;
    let rec: TransferJournalRecord | null = null;
    try {
      rec = parseJournalRecord(raw);
    } catch {
      // A record this build cannot read stays for the build that wrote it.
      return;
    }
    await this.abortQuietly(
      { collection: rec.collection, record: rec.record },
      rec.uploadId,
    );
    await this.deps.journal.delete(id);
  }

  /** @internal What a run reaches the engine's parts through. */
  readonly io: {
    deps: TransferEngineDeps;
    hash: (d: Uint8Array) => Promise<Uint8Array>;
    abortQuietly: (t: FileTarget, uploadId: string) => Promise<void>;
    call: <T>(
      hold: { until: number },
      signal: AbortSignal | undefined,
      fn: () => Promise<FileReply<T>>,
    ) => Promise<FileReply<T>>;
  };

  private async abortQuietly(t: FileTarget, uploadId: string): Promise<void> {
    try {
      await this.deps.transport.abort(t, uploadId, {});
    } catch {
      // The server expires it within the day.
    }
  }

  private async verifySource(req: UploadRequest): Promise<void> {
    const h = new Sha256();
    for (let at = 0; at < req.size; at += HASH_SLICE) {
      const end = Math.min(req.size, at + HASH_SLICE);
      const piece = await req.source.read(at, end, req.signal);
      if (piece.length !== end - at) throw new TransferError("source-mismatch");
      h.update(piece);
    }
    if (toHex(h.digest()) !== req.sha256)
      throw new TransferError("source-mismatch");
  }

  /** The matching journal record, or null (and the stale one dropped). A record that cannot be read is an error and stays. */
  private async loadRecord(
    req: UploadRequest,
  ): Promise<TransferJournalRecord | null> {
    const raw = await this.deps.journal.get(req.id);
    if (raw === null) return null;
    let rec: TransferJournalRecord;
    try {
      rec = parseJournalRecord(raw);
    } catch (e) {
      if (e instanceof TransferJournalError)
        throw new TransferError(
          e.reason === "version" ? "journal-version" : "journal-malformed",
        );
      throw e;
    }
    const target = { collection: rec.collection, record: rec.record };
    const same =
      rec.collection === req.collection &&
      rec.record === req.record &&
      rec.sha256 === req.sha256 &&
      rec.size === req.size;
    // `expiresAt` is Unix seconds. Read as milliseconds by a server that sends them, it is
    // never in the past here, and the server's 410 still ends the upload.
    const live = rec.expiresAt > this.now() / 1000;
    if (same && live) return rec;
    if (!same) await this.abortQuietly(target, rec.uploadId);
    await this.deps.journal.delete(req.id);
    return null;
  }

  /** One request with the recovery rules: a refusal is returned, a retryable failure is waited out. */
  private async call<T>(
    hold: { until: number },
    signal: AbortSignal | undefined,
    fn: () => Promise<FileReply<T>>,
  ): Promise<FileReply<T>> {
    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw new TransferError("aborted");
      const wait = hold.until - this.now();
      if (wait > 0) await this.sleep(wait, signal);
      let reply: FileReply<T> | null = null;
      try {
        reply = await fn();
      } catch (e) {
        if (signal?.aborted) throw new TransferError("aborted");
        if (e instanceof TransferError) throw e;
        // No answer: the network, a timeout.
      }
      if (reply?.ok) return reply;
      const status = reply === null ? 0 : reply.status;
      const retryable =
        reply === null || status === 408 || status === 429 || status >= 500;
      if (!retryable) return reply as FileReply<T>;
      if (attempt + 1 >= this.maxAttempts)
        throw new TransferError("retries-exhausted", {
          ...(reply === null ? {} : { status, code: reply.code }),
        });
      const told = reply !== null ? reply.retryAfterSeconds : undefined;
      const delay =
        told !== undefined && told >= 0
          ? Math.min(told * 1000, this.maxRetryAfterMs)
          : Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt) *
            (0.5 + this.random() / 2);
      hold.until = Math.max(hold.until, this.now() + delay);
    }
  }
}

/** One pass at one upload: begin or resume, send what is missing, finalize. */
class Run {
  private readonly target: FileTarget;
  private readonly hold = { until: 0 };
  private rec!: TransferJournalRecord;
  private saving: Promise<void> = Promise.resolve();
  private failure: unknown = null;

  constructor(
    private readonly engine: TransferEngine,
    private readonly req: UploadRequest,
    private readonly resume: TransferJournalRecord | null,
  ) {
    this.target = { collection: req.collection, record: req.record };
  }

  private get io() {
    return this.engine.io;
  }
  private get transport() {
    return this.io.deps.transport;
  }
  private get opts(): FileCallOptions {
    return this.req.signal ? { signal: this.req.signal } : {};
  }

  async go(): Promise<FinalizeResponse> {
    if (this.resume === null) await this.begin();
    else {
      this.rec = this.resume;
      if (this.rec.state === "uploading") await this.reconcile();
    }
    if (this.rec.state === "uploading") {
      await this.sendMissing();
      await this.update({ state: "finalizing" });
    }
    return this.finalize();
  }

  private send<T>(fn: () => Promise<FileReply<T>>): Promise<FileReply<T>> {
    return this.io.call(this.hold, this.req.signal, fn);
  }

  /** A refusal that no retry mends, as the error it is. A 410 starts the upload over. */
  private refuse(reply: Extract<FileReply<unknown>, { ok: false }>): never {
    if (reply.status === 410 || reply.status === 404) throw new Restart();
    const body = reply.body as { server?: { version?: unknown } } | undefined;
    const v = body?.server?.version;
    if (reply.status === 409)
      throw new TransferError("conflict", {
        status: 409,
        code: reply.code,
        ...(typeof v === "number" ? { serverVersion: v } : {}),
      });
    if (reply.status === 400 && reply.code === "upload_mismatch")
      throw new TransferError("mismatch", {
        status: 400,
        code: reply.code,
      });
    throw new TransferError("rejected", {
      status: reply.status,
      code: reply.code,
    });
  }

  private async begin(): Promise<void> {
    const r = this.req;
    const reply = await this.send(() =>
      this.transport.begin(
        this.target,
        {
          size: r.size,
          sha256: r.sha256,
          format: "whole",
          enc: r.enc,
          ...(r.baseVersion !== undefined
            ? { baseVersion: r.baseVersion }
            : {}),
        },
        this.opts,
      ),
    );
    if (!reply.ok) {
      // A 410 or 404 on begin is not a stale upload: surface it.
      if (reply.status === 410 || reply.status === 404)
        throw new TransferError("rejected", {
          status: reply.status,
          code: reply.code,
        });
      this.refuse(reply);
    }
    const b = reply.value;
    let partBytes: number | null = null;
    if (b.mode === "multipart") {
      partBytes = b.partBytes ?? null;
      const ok =
        typeof partBytes === "number" &&
        Number.isSafeInteger(partBytes) &&
        partBytes >= 1 &&
        partBytes <= SYNC_PART_MAX_BYTES &&
        Math.ceil(r.size / partBytes) <= SYNC_MAX_PARTS;
      if (!ok) {
        await this.io.abortQuietly(this.target, b.uploadId);
        throw new TransferError("bad-reply");
      }
    } else if (b.mode !== "single" || r.size > SYNC_SINGLE_PUT_MAX_BYTES) {
      // `chunks` is part II; a file this big is never one PUT.
      await this.io.abortQuietly(this.target, b.uploadId);
      throw new TransferError("bad-reply");
    }
    this.rec = {
      v: TRANSFER_JOURNAL_VERSION,
      id: r.id,
      kind: "upload",
      collection: r.collection,
      record: r.record,
      uploadId: b.uploadId,
      mode: b.mode,
      partBytes,
      done: [],
      sha256: r.sha256,
      size: r.size,
      expiresAt: b.expiresAt,
      state: "uploading",
    };
    await this.update({});
  }

  /** The server's list of received parts replaces the journal's `done`. */
  private async reconcile(): Promise<void> {
    const reply = await this.send(() =>
      this.transport.status(this.target, this.rec.uploadId, this.opts),
    );
    if (!reply.ok) this.refuse(reply);
    if (this.rec.mode !== "multipart") return;
    const got = reply.value.received ?? [];
    const parts = this.partCount();
    const done = [
      ...new Set(
        got.filter((n) => Number.isInteger(n) && n >= 1 && n <= parts),
      ),
    ].sort((a, b) => a - b);
    await this.update({ done });
  }

  private partCount(): number {
    const { mode, partBytes, size } = this.rec;
    return mode === "multipart" ? Math.ceil(size / (partBytes as number)) : 1;
  }

  /** Persist a change to the record. Writes are queued so a late one never overtakes an early one. */
  private update(change: Partial<TransferJournalRecord>): Promise<void> {
    this.rec = { ...this.rec, ...change };
    const snapshot: TransferJournalRecord = {
      ...this.rec,
      done: [...this.rec.done],
    };
    const next = this.saving.then(() =>
      this.io.deps.journal.put(snapshot.id, snapshot),
    );
    this.saving = next.catch(() => undefined);
    return next;
  }

  private progress(): void {
    const { size, done, mode, partBytes } = this.rec;
    const sent =
      mode === "single"
        ? done.length > 0
          ? size
          : 0
        : done.reduce((n, p) => {
            const range = partRange(
              {
                mode: "multipart",
                partBytes,
                parts: this.partCount(),
              },
              size,
              p,
            );
            return n + (range.end - range.start);
          }, 0);
    this.req.onProgress?.(sent, size);
  }

  private async sendMissing(): Promise<void> {
    const parts = this.partCount();
    const queue: number[] = [];
    for (let n = 1; n <= parts; n++)
      if (!this.rec.done.includes(n)) queue.push(n);
    this.failure = null;
    const worker = async (): Promise<void> => {
      while (this.failure === null) {
        const n = queue.shift();
        if (n === undefined) return;
        try {
          await this.sendPart(n);
        } catch (e) {
          this.failure ??= e;
        }
      }
    };
    const width = Math.min(TRANSFER_MAX_PARALLEL_PARTS, queue.length);
    await Promise.all(Array.from({ length: width }, worker));
    await this.saving;
    if (this.failure !== null) throw this.failure;
  }

  private async sendPart(n: number): Promise<void> {
    const { size, partBytes, uploadId, mode } = this.rec;
    const range =
      mode === "single"
        ? { start: 0, end: size }
        : partRange(
            { mode: "multipart", partBytes, parts: this.partCount() },
            size,
            n,
          );
    const body = await this.req.source.read(
      range.start,
      range.end,
      this.req.signal,
    );
    if (body.length !== range.end - range.start)
      throw new TransferError("source-mismatch");
    const digest = toHex(await this.io.hash(body));
    const reply = await this.send(() =>
      mode === "single"
        ? this.transport.putSingle(
            this.target,
            uploadId,
            body,
            digest,
            this.opts,
          )
        : this.transport.putPart(
            this.target,
            uploadId,
            n,
            body,
            digest,
            this.opts,
          ),
    );
    if (!reply.ok) this.refuse(reply);
    const done = [...this.rec.done, n].sort((a, b) => a - b);
    await this.update({ done });
    this.progress();
  }

  private async finalize(): Promise<FinalizeResponse> {
    for (let again = 0; ; again++) {
      const reply = await this.send(() =>
        this.transport.finalize(
          this.target,
          { uploadId: this.rec.uploadId },
          this.opts,
        ),
      );
      if (reply.ok) {
        await this.saving;
        await this.io.deps.journal.delete(this.req.id);
        return reply.value;
      }
      const missing = (reply.body as { missing?: unknown } | undefined)
        ?.missing;
      if (
        reply.status === 409 &&
        reply.code === "upload_incomplete" &&
        again < 2 &&
        Array.isArray(missing) &&
        missing.every(
          (n) => Number.isInteger(n) && n >= 1 && n <= this.partCount(),
        )
      ) {
        const lost = new Set<number>(missing as number[]);
        await this.update({
          state: "uploading",
          done: this.rec.done.filter((n) => !lost.has(n)),
        });
        await this.sendMissing();
        await this.update({ state: "finalizing" });
        continue;
      }
      if (
        reply.status === 409 ||
        (reply.status === 400 && reply.code === "upload_mismatch")
      ) {
        // The upload cannot become the file: release it.
        await this.io.abortQuietly(this.target, this.rec.uploadId);
        await this.saving;
        await this.io.deps.journal.delete(this.req.id);
      }
      this.refuse(reply);
    }
  }
}
