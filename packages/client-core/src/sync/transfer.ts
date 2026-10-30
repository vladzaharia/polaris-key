// The Cloud Sync file transfer engine (U-22.1, U-22.2; WIRE-CONTRACT-V5 §13.8): uploads in modes
// `single` and `multipart` (`upload`) and `chunks` (`uploadChunked`), and downloads of both
// formats (`download`).
//
// The engine owns the order of calls and the recovery rules, and nothing else. The ports keep it
// pure: a `FileTransport` (the routes of §13.8, typed; a host maps them to HTTP and never lets a
// server-chosen path through), a `JournalStore` (what survives a kill), a `RangedSource` (the
// bytes to send, read by range, so a part is read when it is sent and never held longer), a
// `FileCodec` (whether and how a collection seals its files and chunks) and a `ChunkCache` (the
// chunk objects a device already holds).
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
// The `chunks` upload (U-22.2, plans D-4 to D-7) cuts the plaintext (CDC), names every chunk,
// builds the manifest, and begins with the file's stored `size` and the stored manifest's `sha256`.
// It asks which chunks the server lacks (plan calls of at most 1,024 ids), sends only those as raw
// (codec 0) objects, up to 4 at a time, then sends the manifest to the `single` route and
// finalizes. A journal record only lets the next run abort the upload the last one left: a sealed
// manifest differs every time, and the plan answers what the server already holds. A chunk is read
// twice (cutting, sending) and its id is checked again before it goes, so a file edited while it
// uploads is refused (`source-mismatch`), never stored under another file's id.
//
// A download checks, in order, what the server says against what the record said: the status and
// `Content-Range` of each range, the ETag held fixed with `If-Match`, the stored length and
// SHA-256, then the format's own checks (segment tags; for `chunks` the manifest, every chunk id,
// each length, and last `plainSize` and `plainSha256`). The sink receives plaintext that is only
// provisional until `download` resolves: on a rejection the host discards what it wrote.
// Anything the server could have altered is `file-invalid` (the client's `sync-file-invalid`).
//
// The bytes must be what `sha256` and `size` say: the source is hashed before `begin`, and a source
// that disagrees is refused (`source-mismatch`) with nothing sent. In E2E mode the caller seals
// first, so these are the ciphertext's.

import type {
  BeginFileRequest,
  BeginFileResponse,
  ChunkPlanRequest,
  ChunkPlanResponse,
  FinalizeRequest,
  FinalizeResponse,
  SyncFileEnc,
  UploadStatus,
} from "@polaris-key/protocol/sync";
import {
  SYNC_CHUNK_PLAN_MAX_IDS,
  SYNC_FILE_MAX_BYTES,
  SYNC_MAX_CHUNKS_PER_FILE,
  SYNC_MAX_PARTS,
  SYNC_PART_MAX_BYTES,
  SYNC_SINGLE_PUT_MAX_BYTES,
  SYNC_UPLOAD_PARALLELISM,
} from "@polaris-key/protocol/sync";
import type { ChunkCache } from "./chunkCache.js";
import { CdcChunker } from "./cdc.js";
import { webCryptoSyncPort } from "./crypto.js";
import {
  FileStreamError,
  verifyReassembly,
  type ByteSource,
} from "./fileStream.js";
import {
  encodeManifest,
  MANIFEST_HEADER_BYTES,
  MANIFEST_RECORD_BYTES,
  parseManifest,
  type ManifestRecord,
} from "./manifest.js";
import { Sha256 } from "./sha256.js";
import {
  bytesEqual,
  SERVER_CHUNK_MAX_STORED_BYTES,
  type FileCodec,
} from "./transferCodec.js";
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
  /** `POST …/upload/{uploadId}/chunks`: at most `SYNC_CHUNK_PLAN_MAX_IDS` ids. */
  planChunks(
    target: FileTarget,
    uploadId: string,
    request: ChunkPlanRequest,
    options: FileCallOptions,
  ): Promise<FileReply<ChunkPlanResponse>>;
  /** `PUT …/upload/{uploadId}/chunks/{chunkId}`: one chunk object. `sha256` is the hex of `body`. */
  putChunk(
    target: FileTarget,
    uploadId: string,
    chunkId: string,
    body: Uint8Array,
    sha256: string,
    options: FileCallOptions,
  ): Promise<FileReply<null>>;
  /** `GET …/{id}[?version=]`, with `Range` and `If-Match` when asked. A host bounds the body to the range it asked for. */
  getFile(
    target: FileTarget,
    query: FileQuery,
    options: FileCallOptions,
  ): Promise<FileReply<FileBody>>;
  /** `GET /<p>/sync/files/{collection}/chunks/{chunkId}`. A host bounds the body to `SERVER_CHUNK_MAX_STORED_BYTES`. */
  getChunk(
    collection: string,
    chunkId: string,
    options: FileCallOptions,
  ): Promise<FileReply<Uint8Array>>;
}

export interface FileQuery {
  version?: number;
  /** Half-open byte range of the stored file. */
  range?: { start: number; end: number };
  /** An ETag from an earlier answer; a changed file is then `412`. */
  ifMatch?: string;
}

/** A file answer, headers parsed. */
export interface FileBody {
  status: 200 | 206;
  bytes: Uint8Array;
  /** The `ETag`, verbatim. */
  etag?: string;
  /** A 206's `Content-Range`: bytes `start` up to `end` (exclusive) of `total`. */
  contentRange?: { start: number; end: number; total: number };
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
  | "aborted"
  /** A download failed a check the server could have caused (a tag, the manifest, a chunk id, `plainSha256`, a length, a hash): `detail` says which. The client's `sync-file-invalid`. */
  | "file-invalid";

export class TransferError extends Error {
  readonly status?: number;
  readonly code?: string;
  /** On a `revision_conflict`: the server's current version. */
  readonly serverVersion?: number;
  /** On `file-invalid`: the first check that failed. */
  readonly detail?: string;
  constructor(
    readonly reason: TransferFailure,
    details: {
      status?: number;
      code?: string;
      serverVersion?: number;
      detail?: string;
    } = {},
  ) {
    super(
      `file transfer: ${reason}${details.code ? ` (${details.code})` : ""}${
        details.detail ? ` [${details.detail}]` : ""
      }`,
    );
    this.name = "TransferError";
    if (details.status !== undefined) this.status = details.status;
    if (details.code !== undefined) this.code = details.code;
    if (details.serverVersion !== undefined)
      this.serverVersion = details.serverVersion;
    if (details.detail !== undefined) this.detail = details.detail;
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

export interface ChunkedUploadRequest {
  /** Stable per intended write; the journal key. */
  id: string;
  collection: string;
  /** The wire record id. */
  record: string;
  /** The plaintext of the file. */
  source: RangedSource;
  codec: FileCodec;
  baseVersion?: number | "*";
  /** Plaintext bytes accounted for so far (a chunk the server already holds counts at once) and the file's size. */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** Where a download's plaintext goes: appended in order, provisional until `download` resolves. */
export interface ByteSink {
  write(bytes: Uint8Array): Promise<void>;
}

export interface DownloadRequest {
  collection: string;
  record: string;
  /** The revision to read (`?version=`); absent is the current one. */
  version?: number;
  /** What the record's `file` says. */
  format: "whole" | "chunks";
  /** The stored size and SHA-256 (lowercase hex) of that file: for `chunks`, the file's stored size and the stored manifest's hash. */
  size: number;
  sha256: string;
  codec: FileCodec;
  /** Needed for `chunks`; the engine reads through it and fills it. */
  cache?: ChunkCache;
  sink: ByteSink;
  /** Plaintext bytes written and the file's plaintext size. */
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** The longest range one request asks for. */
export const DOWNLOAD_RANGE_BYTES = 8 * 1024 * 1024;
/** The most a stored manifest can be: 16,384 records and the header, sealed. */
const MANIFEST_PLAIN_MAX_BYTES =
  MANIFEST_HEADER_BYTES + MANIFEST_RECORD_BYTES * SYNC_MAX_CHUNKS_PER_FILE;

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
    const resume = await this.loadRecord(req);
    return this.restarting(req.id, (first) =>
      new Run(this, req, first ? resume : null).go(),
    );
  }

  /** Run a pass; when the server forgot the upload (410), drop the record and begin again, a few times. */
  private async restarting(
    id: string,
    pass: (first: boolean) => Promise<FinalizeResponse>,
  ): Promise<FinalizeResponse> {
    for (let restarts = 0; ; restarts++) {
      try {
        return await pass(restarts === 0);
      } catch (e) {
        if (!(e instanceof Restart)) throw e;
        if (restarts >= this.maxRestarts)
          throw new TransferError("restarts-exhausted", { status: 410 });
        await this.deps.journal.delete(id);
      }
    }
  }

  /**
   * Upload one file as a manifest over content-defined chunks and finalize it. `req.source` is the
   * plaintext. Resolves with the `finalize` answer; the journal record is gone by then.
   */
  async uploadChunked(req: ChunkedUploadRequest): Promise<FinalizeResponse> {
    if (req.source.size > SYNC_FILE_MAX_BYTES)
      throw new TransferError("rejected", { code: "file_too_large" });
    // Read before anything is sent: an unreadable record stops the transfer untouched. A record
    // of an earlier run only tells which server upload to release.
    await this.releasePrior(req.id);
    const cut = await this.cut(req);
    return this.restarting(req.id, () => new ChunkedRun(this, req, cut).go());
  }

  /**
   * Fetch one file and write its plaintext to `req.sink`. Resolves when every check has passed;
   * a rejection (`file-invalid` for anything the server could have altered) leaves the sink's
   * contents unusable, and the host discards them.
   */
  async download(req: DownloadRequest): Promise<void> {
    await new Download(this, req).go();
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

  /** Abort the server upload a journal record names, and forget the record. */
  private async releasePrior(id: string): Promise<void> {
    const raw = await this.deps.journal.get(id);
    if (raw === null) return;
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
    await this.abortQuietly(
      { collection: rec.collection, record: rec.record },
      rec.uploadId,
    );
    await this.deps.journal.delete(id);
  }

  /** Pass one over the plaintext: cut it, name the chunks, hash it, and write the manifest. */
  private async cut(req: ChunkedUploadRequest): Promise<Cut> {
    const { source, codec } = req;
    const chunker = new CdcChunker();
    const whole = new Sha256();
    const records: ManifestRecord[] = [];
    const offsets: number[] = [];
    let at = 0;
    const take = async (chunks: Uint8Array[]): Promise<void> => {
      for (const c of chunks) {
        if (records.length >= SYNC_MAX_CHUNKS_PER_FILE)
          throw new TransferError("rejected", { code: "file_too_large" });
        records.push({ id: await codec.chunkId(c), plainLen: c.length });
        offsets.push(at);
        at += c.length;
      }
    };
    for (let from = 0; from < source.size; from += HASH_SLICE) {
      if (req.signal?.aborted) throw new TransferError("aborted");
      const end = Math.min(source.size, from + HASH_SLICE);
      const piece = await source.read(from, end, req.signal);
      if (piece.length !== end - from)
        throw new TransferError("source-mismatch");
      whole.update(piece);
      await take(chunker.push(piece));
    }
    await take(chunker.finish());
    const manifest = encodeManifest({
      plainSize: source.size,
      plainSha256: whole.digest(),
      records,
    });
    return { records, offsets, manifest, plainSize: source.size };
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

/** A refusal that no retry mends, as the error it is. A 410 or 404 starts the upload over. */
function refuseUpload(
  reply: Extract<FileReply<unknown>, { ok: false }>,
): never {
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
    throw new TransferError("mismatch", { status: 400, code: reply.code });
  throw new TransferError("rejected", {
    status: reply.status,
    code: reply.code,
  });
}

/** What one pass at one transfer shares: the target, a hold on retries and the calls through the engine. */
abstract class Pass {
  protected readonly target: FileTarget;
  protected readonly hold = { until: 0 };

  constructor(
    protected readonly engine: TransferEngine,
    collection: string,
    record: string,
    protected readonly signal: AbortSignal | undefined,
  ) {
    this.target = { collection, record };
  }

  protected get io() {
    return this.engine.io;
  }
  protected get transport() {
    return this.io.deps.transport;
  }
  protected get opts(): FileCallOptions {
    return this.signal ? { signal: this.signal } : {};
  }
  protected send<T>(fn: () => Promise<FileReply<T>>): Promise<FileReply<T>> {
    return this.io.call(this.hold, this.signal, fn);
  }
}

/** A pass that journals: the record, kept in step with what the server holds. */
abstract class UploadPass extends Pass {
  protected rec!: TransferJournalRecord;
  protected saving: Promise<void> = Promise.resolve();

  /** Persist a change to the record. Writes are queued so a late one never overtakes an early one. */
  protected update(change: Partial<TransferJournalRecord>): Promise<void> {
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

  /** The upload cannot become the file: release it on the server and forget the record. */
  protected async discard(): Promise<void> {
    await this.io.abortQuietly(this.target, this.rec.uploadId);
    await this.saving;
    await this.io.deps.journal.delete(this.rec.id);
  }

  /** A refusal of `begin`: a 410 or 404 is not a stale upload, so it surfaces. */
  protected refuseBegin(
    reply: Extract<FileReply<unknown>, { ok: false }>,
  ): never {
    if (reply.status === 410 || reply.status === 404)
      throw new TransferError("rejected", {
        status: reply.status,
        code: reply.code,
      });
    return refuseUpload(reply);
  }

  /** Journal a begun upload. */
  protected async begun(
    id: string,
    b: BeginFileResponse,
    stored: {
      mode: TransferJournalRecord["mode"];
      partBytes: number | null;
      sha256: string;
      size: number;
    },
  ): Promise<void> {
    this.rec = {
      v: TRANSFER_JOURNAL_VERSION,
      id,
      kind: "upload",
      collection: this.target.collection,
      record: this.target.record,
      uploadId: b.uploadId,
      ...stored,
      done: [],
      expiresAt: b.expiresAt,
      state: "uploading",
    };
    await this.update({});
  }

  /** `begin`; a refusal is thrown. */
  protected async beginCall(
    request: BeginFileRequest,
  ): Promise<BeginFileResponse> {
    const reply = await this.send(() =>
      this.transport.begin(this.target, request, this.opts),
    );
    if (!reply.ok) this.refuseBegin(reply);
    return reply.value;
  }

  /**
   * `finalize`. On `409 upload_incomplete` (at most twice) `resend` gets the `missing` list and
   * sends those again, answering false when the list is not one this upload could have; a 409 or a
   * mismatch otherwise releases the upload.
   */
  protected async finalizeCall(
    resend: (missing: unknown) => Promise<boolean>,
  ): Promise<FinalizeResponse> {
    for (let again = 0; ; again++) {
      const reply = await this.send(() =>
        this.transport.finalize(
          this.target,
          { uploadId: this.rec.uploadId },
          this.opts,
        ),
      );
      if (reply.ok) {
        await this.finish();
        return reply.value;
      }
      const missing = (reply.body as { missing?: unknown } | undefined)
        ?.missing;
      if (
        reply.status === 409 &&
        reply.code === "upload_incomplete" &&
        again < 2 &&
        (await resend(missing))
      )
        continue;
      if (
        reply.status === 409 ||
        (reply.status === 400 && reply.code === "upload_mismatch")
      )
        await this.discard();
      refuseUpload(reply);
    }
  }

  /** The upload finished: the record goes. */
  protected async finish(): Promise<void> {
    await this.saving;
    await this.io.deps.journal.delete(this.rec.id);
  }
}

/** One pass at one upload: begin or resume, send what is missing, finalize. */
class Run extends UploadPass {
  private failure: unknown = null;

  constructor(
    engine: TransferEngine,
    private readonly req: UploadRequest,
    private readonly resume: TransferJournalRecord | null,
  ) {
    super(engine, req.collection, req.record, req.signal);
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

  /** A refusal that no retry mends, as the error it is. A 410 starts the upload over. */
  private refuse(reply: Extract<FileReply<unknown>, { ok: false }>): never {
    return refuseUpload(reply);
  }

  private async begin(): Promise<void> {
    const r = this.req;
    const b = await this.beginCall({
      size: r.size,
      sha256: r.sha256,
      format: "whole",
      enc: r.enc,
      ...(r.baseVersion !== undefined ? { baseVersion: r.baseVersion } : {}),
    });
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
    await this.begun(r.id, b, {
      mode: b.mode,
      partBytes,
      sha256: r.sha256,
      size: r.size,
    });
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

  private finalize(): Promise<FinalizeResponse> {
    return this.finalizeCall(async (missing) => {
      if (
        !Array.isArray(missing) ||
        !missing.every(
          (n) => Number.isInteger(n) && n >= 1 && n <= this.partCount(),
        )
      )
        return false;
      const lost = new Set<number>(missing as number[]);
      await this.update({
        state: "uploading",
        done: this.rec.done.filter((n) => !lost.has(n)),
      });
      await this.sendMissing();
      await this.update({ state: "finalizing" });
      return true;
    });
  }
}

/** What pass one over a file leaves: the chunks in file order and the manifest that lists them. */
interface Cut {
  records: ManifestRecord[];
  /** Where each record starts in the plaintext. */
  offsets: number[];
  /** The plain `pkey-sync-chunks/1` manifest. */
  manifest: Uint8Array;
  plainSize: number;
}

/** Run `fn` over `items` with at most `width` in flight; the first failure stops new work and is rethrown once the rest settle. */
async function pool<T>(
  items: T[],
  width: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  let failure: unknown = null;
  const worker = async (): Promise<void> => {
    while (failure === null) {
      const item = queue.shift();
      if (item === undefined) return;
      try {
        await fn(item);
      } catch (e) {
        failure ??= e;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(width, queue.length) }, worker),
  );
  if (failure !== null) throw failure;
}

/** One pass at one `chunks` upload: begin, plan, send the missing chunks, the manifest, finalize. */
class ChunkedRun extends UploadPass {
  private stored!: Uint8Array;
  private storedSha = "";
  /** hex id -> the first record that has it. */
  private readonly unique = new Map<string, number>();
  private done = 0;

  constructor(
    engine: TransferEngine,
    private readonly req: ChunkedUploadRequest,
    private readonly cut: Cut,
  ) {
    super(engine, req.collection, req.record, req.signal);
    cut.records.forEach((r, i) => {
      const id = toHex(r.id);
      if (!this.unique.has(id)) this.unique.set(id, i);
    });
  }

  async go(): Promise<FinalizeResponse> {
    await this.begin();
    this.progress(0);
    const missing = await this.plan();
    await this.sendChunks(missing);
    await this.sendManifest();
    return this.finalize();
  }

  private progress(add: number): void {
    this.done += add;
    this.req.onProgress?.(this.done, this.cut.plainSize);
  }

  private async bad(): Promise<never> {
    await this.discard();
    throw new TransferError("bad-reply");
  }

  private async begin(): Promise<void> {
    const r = this.req;
    // A sealed manifest is different on every run, so it is sealed per begin.
    this.stored = await r.codec.sealManifest(this.cut.manifest);
    this.storedSha = toHex(await this.io.hash(this.stored));
    const size = r.codec.storedSize(this.cut.plainSize);
    const b = await this.beginCall({
      size,
      sha256: this.storedSha,
      format: "chunks",
      enc: r.codec.enc,
      ...(r.baseVersion !== undefined ? { baseVersion: r.baseVersion } : {}),
    });
    if (b.mode !== "chunks") {
      await this.io.abortQuietly(this.target, b.uploadId);
      throw new TransferError("bad-reply");
    }
    await this.begun(r.id, b, {
      mode: "chunks",
      partBytes: null,
      sha256: this.storedSha,
      size,
    });
  }

  /** The ids the server lacks, in file order. Every id sent is answered exactly once or the reply is refused. */
  private async plan(): Promise<string[]> {
    const { records } = this.cut;
    const ids = [...this.unique.keys()];
    const missing = new Set<string>();
    for (let at = 0; at < ids.length; at += SYNC_CHUNK_PLAN_MAX_IDS) {
      const batch = ids.slice(at, at + SYNC_CHUNK_PLAN_MAX_IDS);
      const asked = new Set(batch);
      const reply = await this.send(() =>
        this.transport.planChunks(
          this.target,
          this.rec.uploadId,
          {
            chunks: batch.map((id) => [
              id,
              this.req.codec.chunkObjectBytes(
                records[this.unique.get(id)!]!.plainLen,
              ),
            ]),
          },
          this.opts,
        ),
      );
      if (!reply.ok) refuseUpload(reply);
      const said = new Set<string>();
      const lists = reply.value;
      if (!Array.isArray(lists.missing) || !Array.isArray(lists.present))
        return this.bad();
      for (const id of lists.missing) {
        if (typeof id !== "string" || !asked.has(id) || said.has(id))
          return this.bad();
        said.add(id);
        missing.add(id);
      }
      for (const entry of lists.present) {
        const id = Array.isArray(entry) ? entry[0] : undefined;
        if (typeof id !== "string" || !asked.has(id) || said.has(id))
          return this.bad();
        said.add(id);
        this.progress(records[this.unique.get(id)!]!.plainLen);
      }
      if (said.size !== asked.size) return this.bad();
    }
    return ids.filter((id) => missing.has(id));
  }

  private async sendChunks(ids: string[]): Promise<void> {
    await pool(ids, TRANSFER_MAX_PARALLEL_PARTS, async (id) => {
      const i = this.unique.get(id);
      if (i === undefined) throw new TransferError("bad-reply");
      const rec = this.cut.records[i]!;
      const start = this.cut.offsets[i]!;
      const plain = await this.req.source.read(
        start,
        start + rec.plainLen,
        this.req.signal,
      );
      // The file may have changed since it was cut: what is sent must still be the chunk named.
      if (
        plain.length !== rec.plainLen ||
        !bytesEqual(await this.req.codec.chunkId(plain), rec.id)
      )
        throw new TransferError("source-mismatch");
      const object = await this.req.codec.sealChunk(rec.id, plain);
      const digest = toHex(await this.io.hash(object));
      const reply = await this.send(() =>
        this.transport.putChunk(
          this.target,
          this.rec.uploadId,
          id,
          object,
          digest,
          this.opts,
        ),
      );
      if (!reply.ok) refuseUpload(reply);
      this.progress(rec.plainLen);
    });
  }

  private async sendManifest(): Promise<void> {
    const reply = await this.send(() =>
      this.transport.putSingle(
        this.target,
        this.rec.uploadId,
        this.stored,
        this.storedSha,
        this.opts,
      ),
    );
    if (!reply.ok) refuseUpload(reply);
    await this.update({ state: "finalizing" });
  }

  private finalize(): Promise<FinalizeResponse> {
    return this.finalizeCall(async (lost) => {
      if (
        !Array.isArray(lost) ||
        !lost.every((id) => typeof id === "string" && this.unique.has(id))
      )
        return false;
      await this.sendChunks(lost as string[]);
      return true;
    });
  }
}

/** A refusal on a download. Nothing here restarts: a 404 or 410 means the revision is gone. */
function refuseDownload(
  reply: Extract<FileReply<unknown>, { ok: false }>,
): never {
  throw new TransferError("rejected", {
    status: reply.status,
    code: reply.code,
  });
}

const invalid = (detail: string): TransferError =>
  new TransferError("file-invalid", { detail });

/** One download: fetch the stored bytes, check them, and write the plaintext. */
class Download extends Pass {
  private written = 0;
  private total = 0;

  constructor(
    engine: TransferEngine,
    private readonly req: DownloadRequest,
  ) {
    super(engine, req.collection, req.record, req.signal);
  }

  async go(): Promise<void> {
    const { size, sha256 } = this.req;
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      size > this.req.codec.storedSize(SYNC_FILE_MAX_BYTES)
    )
      throw invalid("size");
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw invalid("sha256");
    try {
      if (this.req.format === "whole") await this.whole();
      else await this.chunked();
    } catch (e) {
      if (e instanceof FileStreamError) throw invalid(e.reason);
      throw e;
    }
  }

  private async emit(piece: Uint8Array): Promise<void> {
    await this.req.sink.write(piece);
    this.written += piece.length;
    this.req.onProgress?.(this.written, this.total);
  }

  /** A whole file: ranges of the stored bytes, opened as they arrive. */
  private async whole(): Promise<void> {
    const plainSize = this.req.codec.plainSize(this.req.size);
    if (plainSize === null) throw invalid("size");
    this.total = plainSize;
    for await (const piece of this.req.codec.openStream(this.stored())) {
      if (this.req.signal?.aborted) throw new TransferError("aborted");
      await this.emit(piece);
    }
    if (this.written !== plainSize) throw invalid("size");
  }

  /**
   * The stored bytes of the file in ranges. Every range is asked with the ETag the first answer
   * gave (`If-Match`), its status and `Content-Range` are checked against what was asked, and the
   * length and SHA-256 are checked after the last one: until this generator ends, what it
   * yielded is provisional.
   */
  private async *stored(): AsyncGenerator<Uint8Array> {
    const { size, sha256 } = this.req;
    const hash = new Sha256();
    let etag: string | undefined;
    let at = 0;
    while (at < size) {
      const end = Math.min(size, at + DOWNLOAD_RANGE_BYTES);
      const ask = at;
      const reply = await this.send(() =>
        this.transport.getFile(
          this.target,
          {
            ...(this.req.version !== undefined
              ? { version: this.req.version }
              : {}),
            range: { start: ask, end },
            ...(etag !== undefined ? { ifMatch: etag } : {}),
          },
          this.opts,
        ),
      );
      if (!reply.ok) refuseDownload(reply);
      const body = reply.value;
      if (etag !== undefined && body.etag !== undefined && body.etag !== etag)
        throw new TransferError("bad-reply", { detail: "etag" });
      etag ??= body.etag;
      let piece: Uint8Array;
      if (body.status === 206) {
        const cr = body.contentRange;
        if (
          !cr ||
          cr.start !== ask ||
          cr.total !== size ||
          cr.end <= cr.start ||
          cr.end > end ||
          body.bytes.length !== cr.end - cr.start
        )
          throw new TransferError("bad-reply", { detail: "content-range" });
        piece = body.bytes;
      } else if (body.status === 200) {
        // A server that ignores `Range` sends the whole file, which only fits from the start.
        if (ask !== 0 || body.bytes.length !== size)
          throw new TransferError("bad-reply", { detail: "status" });
        piece = body.bytes;
      } else throw new TransferError("bad-reply", { detail: "status" });
      hash.update(piece);
      at += piece.length;
      yield piece;
    }
    if (toHex(hash.digest()) !== sha256) throw invalid("sha256");
  }

  /** A chunked file: the manifest, then each chunk from the cache or the server. */
  private async chunked(): Promise<void> {
    const { codec, cache } = this.req;
    const manifestMax = codec.storedSize(MANIFEST_PLAIN_MAX_BYTES);
    const reply = await this.send(() =>
      this.transport.getFile(
        this.target,
        this.req.version !== undefined ? { version: this.req.version } : {},
        this.opts,
      ),
    );
    if (!reply.ok) refuseDownload(reply);
    const stored = reply.value.bytes;
    if (reply.value.status !== 200)
      throw new TransferError("bad-reply", { detail: "status" });
    if (stored.length > manifestMax) throw invalid("manifest-size");
    if (toHex(await this.io.hash(stored)) !== this.req.sha256)
      throw invalid("sha256");
    const opened = await codec.openManifest(stored);
    if (!opened.ok) throw invalid(`manifest-${opened.reason}`);
    const parsed = parseManifest(opened.plain);
    if (!parsed.ok) throw invalid(`manifest-${parsed.reason}`);
    const { manifest } = parsed;
    // The record's size and the manifest's must agree.
    if (codec.storedSize(manifest.plainSize) !== this.req.size)
      throw invalid("size");
    this.total = manifest.plainSize;

    const fetchOne = async (rec: ManifestRecord): Promise<Uint8Array> => {
      const id = toHex(rec.id);
      if (cache) {
        let held: Uint8Array | null = null;
        try {
          held = await cache.get(id);
        } catch {
          // A cache that fails is a miss.
        }
        if (held !== null) {
          const o = await codec.openChunk(rec.id, held);
          if (o.ok && o.plain.length === rec.plainLen) return o.plain;
          try {
            await cache.delete(id);
          } catch {
            // Best effort.
          }
        }
      }
      const got = await this.send(() =>
        this.transport.getChunk(this.req.collection, id, this.opts),
      );
      if (!got.ok) refuseDownload(got);
      const object = got.value;
      if (object.length > SERVER_CHUNK_MAX_STORED_BYTES)
        throw invalid("chunk-size");
      const o = await codec.openChunk(rec.id, object);
      if (!o.ok) throw invalid(`chunk-${o.reason}`);
      if (o.plain.length !== rec.plainLen) throw invalid("chunk-length");
      if (cache) {
        try {
          await cache.put(id, object);
        } catch {
          // Best effort.
        }
      }
      return o.plain;
    };

    // A short window of chunks in flight, delivered in file order.
    const window: Promise<Uint8Array>[] = [];
    let next = 0;
    const fill = (): void => {
      while (
        window.length < TRANSFER_MAX_PARALLEL_PARTS &&
        next < manifest.records.length
      ) {
        const p = fetchOne(manifest.records[next++]!);
        // A failure is raised where it is awaited; this keeps a later one from going unhandled.
        p.catch(() => undefined);
        window.push(p);
      }
    };
    const pieces = async function* (): AsyncGenerator<Uint8Array> {
      fill();
      while (window.length > 0) {
        const plain = await window.shift()!;
        fill();
        yield plain;
      }
    };
    for await (const piece of verifyReassembly(pieces(), {
      plainSize: manifest.plainSize,
      plainSha256: manifest.plainSha256,
    })) {
      if (this.req.signal?.aborted) throw new TransferError("aborted");
      await this.emit(piece);
    }
  }
}
