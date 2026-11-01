// `adapter.cloudSync.saves` in the browser (U-22.7 / SAVES.R): the saves of the signed-in person on
// Cloud Sync records and files. client-core's `SavesClient` owns the steps (file first, then the
// metadata `set`, conflicts, the slot cap, the format check); this module binds it to the machine
// and the browser's file layer, as sdk-node's `cloudSync/saves.ts` does:
//
//   records      `MachineRecords`: `SaveRecords` over the machine's `records`, `putAt` and `removeAt`.
//                A write waits for its one outcome (ok, conflict with the server copy, rejected or
//                dropped by a sign-out) and is never coalesced or rebased. Only the writer tab owns
//                a live machine, so a write from another tab is refused (`sync-not-writer`); reads
//                follow the record and work in every tab.
//   files        `createBrowserFiles`: the fetch transport, the IndexedDB journal and chunk cache,
//                one `TransferEngine` (`maxRetryAfterSeconds` 3600). Every engine entry the saves
//                client uses runs under the Web Lock (`exclusive`), so two tabs never drive the
//                same journal; a cancel or a pause ends a wait for the lock.
//   codec        end-to-end: the ring's `fileCodec("saves")` (it refuses with `sync-locked` once the
//                ring locks); server mode: `serverFileCodec`.
//   events       `transferProgress` / `transferDone` / `transferFailed` to `onTransfers` listeners. A
//                cancelled transfer is a state (`transferDone`), not a failure.
//   purge        the waiting writes, the running transfers, the journal and the chunk cache go with
//                the person; the files layer is closed, so a transfer still running cannot recreate
//                the deleted database.
//
// Nothing here logs a value, a key or a path; events carry ids, counts and codes. Loaded on the first
// call to `saves`, never with the adapter.

import type { Json, RecordOutcome } from "@polaris-key/client-core/cloud-sync";
import {
  SAVES_COLLECTION,
  SavesClient,
  SavesError,
  TransferError,
  isBlindedName,
  serverFileCodec,
  webCryptoSyncPort,
  wireId,
  type DownloadRequest,
  type FileCodec,
  type HostCodec,
  type RangedSource,
  type ReadOptions,
  type SaveConflict,
  type SaveKeep,
  type SaveOutcome,
  type SaveRead,
  type SaveRecord,
  type SaveFileRef,
  type SaveRecords,
  type SaveSetResult,
  type SaveSummary,
  type SaveTransfer,
  type TransferEngine,
  type WriteOptions,
} from "@polaris-key/client-core/sync";
import type { FileRevision } from "@polaris-key/protocol/sync";
import { TransferEvent } from "../../constants.generated.js";
import type { BrowserSaves, SaveTransferEvent } from "../../core/cloudSync.js";
import type { KeyringClient } from "../../core/keyring.js";
import { locked } from "../ring/codec.js";
import type { FileFetch } from "./files.js";
import {
  createBrowserFiles,
  type BrowserFiles,
  type BrowserFilesDeps,
} from "./fileTransfers.js";
import type { BrowserCloudSyncHost } from "./host.js";

type Meta = { [k: string]: Json };

export const SAVES_NOT_WRITER = "sync-not-writer";

const asMeta = (v: Json): Meta =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Meta) : {};

/** What the saves need of the host and the page. */
export interface BrowserSavesDeps {
  host: BrowserCloudSyncHost;
  keyring: Pick<KeyringClient, "codec"> & {
    fileCodec?: KeyringClient["fileCodec"];
  };
  product: string;
  dbName: string;
  fileFetch: FileFetch;
  locks: BrowserFilesDeps["locks"];
  /** Starts the host and signs the machine in (the API's attach). */
  attach: () => Promise<void>;
  /** Test seams, handed to the files layer. */
  files?: Pick<BrowserFilesDeps, "store" | "sleep">;
}

/** `SaveRecords` over the machine. */
export class MachineRecords implements SaveRecords {
  readonly #host: BrowserCloudSyncHost;
  readonly #codec: () => Pick<HostCodec, "blind"> | null;
  readonly #waiting = new Map<number, (o: RecordOutcome) => void>();

  constructor(
    host: BrowserCloudSyncHost,
    codec: () => Pick<HostCodec, "blind"> | null,
  ) {
    this.#host = host;
    this.#codec = codec;
    host.onOutcome((o) => {
      const done = this.#waiting.get(o.mutationId);
      this.#waiting.delete(o.mutationId);
      done?.(o);
    });
  }

  #e2e(): boolean {
    return this.#host.machine.encryptionMode() === "e2e";
  }

  /** Settle every write still waiting as dropped (the person and their data are gone). */
  dropAll(): void {
    for (const [id, done] of [...this.#waiting])
      done({ mutationId: id, status: "dropped" });
    this.#waiting.clear();
  }

  wireId(id: string): Promise<string> {
    return this.#codecId(id);
  }

  async #codecId(id: string): Promise<string> {
    if (!this.#e2e()) return wireId(null, SAVES_COLLECTION, id);
    const codec = this.#codec();
    if (codec === null) throw locked();
    return wireId(codec, SAVES_COLLECTION, id);
  }

  #record(
    row: { id: string; value: Json; version: number; file: SaveRecord["file"] },
    id = row.id,
  ): SaveRecord {
    return {
      id,
      version: row.version,
      value: asMeta(row.value),
      file: row.file,
    };
  }

  async list(): Promise<SaveRecord[]> {
    const e2e = this.#e2e();
    return this.#host.machine
      .records(SAVES_COLLECTION)
      .filter((r) => !(e2e && isBlindedName(r.id)))
      .map((r) => this.#record(r));
  }

  async get(id: string): Promise<SaveRecord | null> {
    const rows = this.#host.machine.records(SAVES_COLLECTION);
    let row = rows.find((r) => r.id === id);
    // A record that has a file and no value comes back under its wire id (the host cannot place
    // its blinded id without a value).
    if (row === undefined && this.#e2e()) {
      const wire = await this.#codecId(id);
      row = rows.find((r) => r.id === wire);
    }
    return row === undefined ? null : this.#record(row, id);
  }

  async #wait(
    call: () => { ok: true; mutationId: number } | { ok: false; error: string },
    cancel?: AbortSignal,
  ): Promise<SaveSetResult> {
    if (!this.#host.isWriter)
      return { ok: false, reason: "rejected", code: SAVES_NOT_WRITER };
    this.#host.catchUp();
    let settle: (o: RecordOutcome) => void = () => undefined;
    const outcome = new Promise<RecordOutcome>((resolve) => (settle = resolve));
    const started = call();
    if (!started.ok)
      return { ok: false, reason: "rejected", code: started.error };
    this.#waiting.set(started.mutationId, settle);
    void this.#host.touch();
    // No timeout: a cancel, a sign-out drop or the host's retries end the wait.
    const aborted = new Promise<never>((_, reject) => {
      const stop = (): void => {
        this.#waiting.delete(started.mutationId);
        reject(new TransferError("aborted"));
      };
      if (cancel?.aborted) stop();
      else cancel?.addEventListener("abort", stop, { once: true });
    });
    const o = await Promise.race([outcome, aborted]);
    switch (o.status) {
      case "ok":
        return { ok: true, version: o.version };
      case "conflict":
        return {
          ok: false,
          reason: "conflict",
          server:
            o.server === null
              ? null
              : {
                  id: "",
                  version: o.server.version,
                  value: asMeta(o.server.value),
                  file: o.server.file,
                },
        };
      case "rejected":
        return { ok: false, reason: "rejected", code: o.code };
      case "dropped":
        return { ok: false, reason: "rejected", code: "signed-out" };
    }
  }

  async set(
    id: string,
    value: Meta,
    baseVersion: number | "*",
    cancel?: AbortSignal,
    file?: SaveFileRef,
  ): Promise<SaveSetResult> {
    const r = await this.#wait(
      () =>
        this.#host.machine.putAt(
          SAVES_COLLECTION,
          id,
          value,
          baseVersion,
          file,
        ),
      cancel,
    );
    return r.ok === false && r.reason === "conflict" && r.server !== null
      ? { ...r, server: { ...r.server, id } }
      : r;
  }

  async delete(id: string, baseVersion: number): Promise<SaveSetResult> {
    const r = await this.#wait(() =>
      this.#host.machine.removeAt(SAVES_COLLECTION, id, baseVersion),
    );
    return r.ok === false && r.reason === "conflict" && r.server !== null
      ? { ...r, server: { ...r.server, id } }
      : r;
  }
}

/**
 * The engine as the saves client uses it, every entry under the Web Lock. A cancel of a request
 * ends its wait for the lock; the lock is then released at once by the queued run.
 */
export function lockedEngine(files: BrowserFiles): TransferEngine {
  const aborted = (signal: AbortSignal): Promise<never> =>
    new Promise((_, reject) => {
      if (signal.aborted) reject(new TransferError("aborted"));
      else
        signal.addEventListener(
          "abort",
          () => reject(new TransferError("aborted")),
          { once: true },
        );
    });
  const run = <T>(
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const queued = files.exclusive(async () => {
      // A pause or cancel that came while this waited for the lock: give it back unused.
      if (signal?.aborted) throw new TransferError("aborted");
      return fn();
    });
    if (signal === undefined) return queued;
    queued.catch(() => undefined);
    return Promise.race([queued, aborted(signal)]);
  };
  const e = files.engine;
  const entries: Pick<
    TransferEngine,
    "upload" | "uploadChunked" | "download" | "cancel"
  > = {
    upload: (r) => run(r.signal, () => e.upload(r)),
    uploadChunked: (r) => run(r.signal, () => e.uploadChunked(r)),
    download: (r: DownloadRequest) => run(r.signal, () => e.download(r)),
    cancel: (id) => files.exclusive(() => e.cancel(id)),
  };
  return entries as TransferEngine;
}

/** The ring's file codec for the saves, or `sync-locked` while no root is held. */
async function e2eCodec(deps: BrowserSavesDeps): Promise<FileCodec> {
  const c = (await deps.keyring.fileCodec?.(SAVES_COLLECTION)) ?? null;
  if (c === null) throw locked();
  return c;
}

/** `adapter.cloudSync.saves`. */
export class SavesApi implements BrowserSaves {
  readonly #d: BrowserSavesDeps;
  readonly #records: MachineRecords;
  #files: BrowserFiles | null = null;
  #engine: TransferEngine | null = null;
  readonly #active = new Map<string, SaveTransfer>();
  readonly #conflicts = new Map<string, SaveConflict>();
  /** Bumped by every purge: a call that began before one never builds on, or records into, what the
   *  purge deleted. */
  #gen = 0;
  readonly #listeners = new Set<(e: SaveTransferEvent | null) => void>();

  constructor(deps: BrowserSavesDeps) {
    this.#d = deps;
    this.#records = new MachineRecords(deps.host, () => deps.keyring.codec());
  }

  // ── What app code calls ──────────────────────────────────────────────────────────────────

  /** The saves of this person (at most 16), by id. */
  async list(): Promise<SaveSummary[]> {
    return (await this.#client()).list();
  }

  /** The kept revisions of a save's file, newest first. */
  async revisions(id: string): Promise<FileRevision[]> {
    return (await this.#client()).revisions(id);
  }

  /** Read a save: its metadata and bytes. */
  async read(id: string, opts: ReadOptions = {}): Promise<SaveRead> {
    const client = await this.#client();
    const tid = `saves:read:${id}`;
    try {
      const r = await client.read(id, {
        ...opts,
        onProgress: (done, total) => {
          opts.onProgress?.(done, total);
          this.#emit({
            type: TransferEvent.transferprogress,
            id: tid,
            done,
            total,
          });
        },
      });
      this.#emit({ type: TransferEvent.transferdone, id: tid, state: "done" });
      return r;
    } catch (e) {
      this.#emit({
        type: TransferEvent.transferfailed,
        id: tid,
        code: e instanceof SavesError ? e.code : "transfer-failed",
      });
      throw e;
    }
  }

  /**
   * Write a save. Resolves with a handle at once; `done` settles on done, cancelled, failed or
   * conflict. The handle is in `transfers()` until then. The wait for the metadata write has no
   * timeout: `cancel()`, a sign-out (the write is dropped) and the host's retries end it. Only the
   * writer tab can write; another tab's call rejects with `sync-not-writer`.
   */
  async write(
    id: string,
    bytes: Uint8Array | RangedSource,
    metadata: Meta,
    opts: WriteOptions = {},
  ): Promise<SaveTransfer> {
    const gen = this.#gen;
    const client = await this.#client(true);
    return this.#track(
      client.write(id, bytes, metadata, this.#progress(`saves:${id}`, opts)),
      gen,
    );
  }

  /** Settle a conflict: keep the remote copy, write the local one on top, or keep both. */
  async resolve(
    conflict: SaveConflict,
    keep: SaveKeep,
    bytes: Uint8Array | RangedSource,
    opts: WriteOptions = {},
  ): Promise<SaveTransfer> {
    const gen = this.#gen;
    const client = await this.#client(true);
    return this.#track(
      client.resolve(
        conflict,
        keep,
        bytes,
        this.#progress(`saves:${conflict.id}`, opts),
      ),
      gen,
    );
  }

  /** Delete a save; its file is collected with the record. */
  async delete(id: string, baseVersion?: number): Promise<SaveSetResult> {
    return (await this.#client(true)).delete(id, baseVersion);
  }

  /** The writes in flight (running, paused or waiting on the lock or the network). */
  transfers(): SaveTransfer[] {
    return [...this.#active.values()];
  }

  /** The conflicts a write ended with that nobody has settled or dismissed yet. */
  conflicts(): SaveConflict[] {
    return [...this.#conflicts.values()];
  }

  /** Forget a conflict without settling it. */
  dismissConflict(id: string): void {
    if (this.#conflicts.delete(id)) this.#emit(null);
  }

  /** Transfer events, in order; `null` when the set of transfers changed. */
  onTransfers(listener: (e: SaveTransferEvent | null) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ── What the client calls ────────────────────────────────────────────────────────────────

  /** The person's data is gone: cancel what runs, settle waiting writes, delete the journal and
   *  the chunk cache, and close the files layer. Each step is tried whatever the other did. */
  async purge(): Promise<void> {
    this.#gen++;
    const running = [...this.#active.values()];
    this.#active.clear();
    this.#conflicts.clear();
    this.#records.dropAll();
    const files = this.#files;
    this.#files = null;
    this.#engine = null;
    await Promise.all(running.map((t) => t.cancel().catch(() => undefined)));
    await files?.purge().catch(() => undefined);
    this.#emit(null);
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────

  #emit(e: SaveTransferEvent | null): void {
    for (const fn of [...this.#listeners]) {
      try {
        fn(e);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /** The caller's progress callback, plus a `transferProgress` event. */
  #progress(id: string, opts: WriteOptions): WriteOptions {
    return {
      ...opts,
      onProgress: (done, total) => {
        opts.onProgress?.(done, total);
        this.#emit({ type: TransferEvent.transferprogress, id, done, total });
      },
    };
  }

  #filesLayer(): { files: BrowserFiles; engine: TransferEngine } {
    if (this.#files === null || this.#engine === null) {
      const d = this.#d;
      const o = d.host.savesOptions;
      this.#files = createBrowserFiles({
        product: d.product,
        dbName: d.dbName,
        fileFetch: d.fileFetch,
        locks: d.locks,
        ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}),
        ...d.files,
      });
      this.#engine = lockedEngine(this.#files);
    }
    return { files: this.#files, engine: this.#engine };
  }

  async #client(write = false): Promise<SavesClient> {
    const d = this.#d;
    const gen = this.#gen;
    const purged = (): SavesError => new SavesError("rejected", "signed-out");
    await d.attach();
    if (gen !== this.#gen) throw purged();
    if (!d.host.started) throw new SavesError("rejected", "sync-not-started");
    if (write && !d.host.isWriter)
      throw new SavesError("rejected", SAVES_NOT_WRITER);
    const e2e = d.host.machine.encryptionMode() === "e2e";
    const codec: FileCodec = e2e
      ? await e2eCodec(d)
      : serverFileCodec(webCryptoSyncPort);
    // A purge that ran while this waited wins: no files layer is built for the person who left.
    if (gen !== this.#gen) throw purged();
    const o = d.host.savesOptions;
    const { files, engine } = this.#filesLayer();
    return new SavesClient({
      records: this.#records,
      engine,
      transport: files.transport,
      codec,
      delta: o.delta,
      ...(o.delta ? { cache: files.cache } : {}),
      ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}),
      ...(o.saveFormatVersion !== undefined
        ? { saveFormatVersion: o.saveFormatVersion }
        : {}),
    });
  }

  /** Register a write, emit its events, and drop it from `transfers()` when it settles. */
  #track(t: SaveTransfer, gen: number): SaveTransfer {
    if (gen !== this.#gen) {
      void t.cancel().catch(() => undefined);
      return t;
    }
    this.#active.set(t.id, t);
    this.#emit(null);
    void t.done.then((o: SaveOutcome) => {
      this.#active.delete(t.id);
      if (o.state === "conflict")
        this.#conflicts.set(o.conflict.id, o.conflict);
      else if (o.state === "done" && "id" in o) this.#conflicts.delete(o.id);
      if (o.state === "failed")
        this.#emit({
          type: TransferEvent.transferfailed,
          id: t.id,
          code: o.error.code,
        });
      else
        this.#emit({
          type: TransferEvent.transferdone,
          id: t.id,
          state: o.state,
        });
    });
    return t;
  }
}
