// `client.cloudSync.saves` (U-22.5): the saves of the signed-in person on Cloud Sync records and
// files. client-core's `SavesClient` owns the steps (file first, then the metadata `set`, conflicts,
// the slot cap, the format check); this module binds it to the machine and the Node transports:
//
//   records      `MachineRecords`: `SaveRecords` over the machine's `records`, `putAt` and `removeAt`.
//                A write waits for its one outcome (ok, conflict with the server copy, rejected or
//                dropped by a sign-out) and is never coalesced or rebased.
//   files        `NodeFileTransport` + `FileJournal` + `FileChunkCache` under one `TransferEngine`
//                (`maxRetryAfterSeconds` 3600).
//   codec        end-to-end: the ring's `fileCodec("saves")`; server mode: `serverFileCodec`.
//   events       `transferProgress` / `transferDone` / `transferFailed` on `client.events` under the
//                `cloudSync` kind. A cancelled transfer is a state (`transferDone`), not a failure.
//   purge        the journal, the chunk cache and any waiting write go with the person.
//
// Nothing here logs a value, a key or a path; events carry ids, counts and codes.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Json, RecordOutcome } from "@polaris-key/client-core/cloud-sync";
import {
  SAVES_COLLECTION,
  SavesClient,
  SavesError,
  TransferEngine,
  chunkCacheBudget,
  isBlindedName,
  serverFileCodec,
  webCryptoSyncPort,
  wireId,
  type FileCodec,
  type HostCodec,
  type ReadOptions,
  type RangedSource,
  type SaveConflict,
  type SaveKeep,
  type SaveOutcome,
  type SaveRead,
  type SaveRecord,
  type SaveRecords,
  type SaveSetResult,
  type SaveSummary,
  type SaveTransfer,
  type WriteOptions,
} from "@polaris-key/client-core/sync";
import type { FileRevision } from "@polaris-key/protocol/sync";
import { Feature, TransferEvent } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import type { TokenManager } from "../core/token.js";
import type { SaveTransferEvent } from "../core/events.js";
import type { KeyringClient } from "../keyring/client.js";
import {
  CLOUD_SYNC_CHUNKS_DIR,
  FileChunkCache,
  chunkCacheDir,
} from "./chunkCache.js";
import { NodeFileTransport } from "./files.js";
import type { CloudSyncHost } from "./host.js";
import { FileJournal } from "./journal.js";

type Meta = { [k: string]: Json };

/** Retry-After is honoured up to an hour: a save may wait out a long throttle. */
export const SAVES_MAX_RETRY_AFTER_SECONDS = 3600;

export type { SaveTransferEvent };

export interface SavesApiDeps {
  ctx: CoreContext;
  host: CloudSyncHost;
  keyring: KeyringClient;
  tokens: TokenManager;
  /** The person the machine is signed in as, or null. */
  subject: () => string | null;
  /** Starts the host and signs the machine in (the Cloud Sync API's attach). */
  attach: () => Promise<void>;
  /** `client.events.safeEmit("cloudSync", …)`. */
  emit: (e: SaveTransferEvent) => void;
}

const asMeta = (v: Json): Meta =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Meta) : {};

/** `SaveRecords` over the machine. */
export class MachineRecords implements SaveRecords {
  readonly #host: CloudSyncHost;
  readonly #codec: Pick<HostCodec, "blind">;
  readonly #e2e: () => boolean;
  readonly #waiting = new Map<number, (o: RecordOutcome) => void>();

  constructor(
    host: CloudSyncHost,
    codec: Pick<HostCodec, "blind">,
    e2e: () => boolean,
  ) {
    this.#host = host;
    this.#codec = codec;
    this.#e2e = e2e;
    host.onOutcome((o) => {
      const done = this.#waiting.get(o.mutationId);
      this.#waiting.delete(o.mutationId);
      done?.(o);
    });
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

  #codecId(id: string): Promise<string> {
    return wireId(this.#e2e() ? this.#codec : null, SAVES_COLLECTION, id);
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
  ): Promise<SaveSetResult> {
    this.#host.catchUp();
    let settle: (o: RecordOutcome) => void = () => undefined;
    const outcome = new Promise<RecordOutcome>((resolve) => (settle = resolve));
    const started = call();
    if (!started.ok)
      return { ok: false, reason: "rejected", code: started.error };
    this.#waiting.set(started.mutationId, settle);
    void this.#host.touch();
    const o = await outcome;
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
  ): Promise<SaveSetResult> {
    const r = await this.#wait(() =>
      this.#host.machine.putAt(SAVES_COLLECTION, id, value, baseVersion),
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

/** `client.cloudSync.saves`. */
export class SavesApi {
  readonly #d: SavesApiDeps;
  readonly #records: MachineRecords;
  readonly #journal: FileJournal;
  readonly #transport: NodeFileTransport;
  readonly #engine: TransferEngine;
  readonly #active = new Map<string, SaveTransfer>();

  constructor(deps: SavesApiDeps) {
    this.#d = deps;
    this.#records = new MachineRecords(
      deps.host,
      deps.keyring.codec,
      () => deps.host.machine.encryptionMode() === "e2e",
    );
    this.#journal = new FileJournal(deps.ctx.dirs.state);
    this.#transport = new NodeFileTransport({
      ctx: deps.ctx,
      token: () => deps.tokens.current,
    });
    this.#engine = new TransferEngine({
      transport: this.#transport,
      journal: this.#journal,
      maxRetryAfterSeconds: SAVES_MAX_RETRY_AFTER_SECONDS,
    });
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
          this.#d.emit({
            type: TransferEvent.transferprogress,
            id: tid,
            done,
            total,
          });
        },
      });
      this.#d.emit({
        type: TransferEvent.transferdone,
        id: tid,
        state: "done",
      });
      return r;
    } catch (e) {
      this.#d.emit({
        type: TransferEvent.transferfailed,
        id: tid,
        code: e instanceof SavesError ? e.code : "transfer-failed",
      });
      throw e;
    }
  }

  /**
   * Write a save. Resolves with a handle at once; `done` settles on done, cancelled, failed or
   * conflict. The handle is in `transfers()` until then.
   */
  async write(
    id: string,
    bytes: Uint8Array | RangedSource,
    metadata: Meta,
    opts: WriteOptions = {},
  ): Promise<SaveTransfer> {
    const client = await this.#client();
    return this.#track(
      client.write(id, bytes, metadata, this.#progress(`saves:${id}`, opts)),
    );
  }

  /** Settle a conflict: keep the remote copy, write the local one on top, or keep both. */
  async resolve(
    conflict: SaveConflict,
    keep: SaveKeep,
    bytes: Uint8Array | RangedSource,
    opts: WriteOptions = {},
  ): Promise<SaveTransfer> {
    const client = await this.#client();
    return this.#track(
      client.resolve(
        conflict,
        keep,
        bytes,
        this.#progress(`saves:${conflict.id}`, opts),
      ),
    );
  }

  /** Delete a save; its file is collected with the record. */
  async delete(id: string, baseVersion?: number): Promise<SaveSetResult> {
    return (await this.#client()).delete(id, baseVersion);
  }

  /** The writes in flight (running, paused or waiting on the network). */
  transfers(): SaveTransfer[] {
    return [...this.#active.values()];
  }

  // ── What the client calls ────────────────────────────────────────────────────────────────

  /** The person's data is gone: cancel what runs, settle waiting writes, delete the journal and
   *  the chunk cache. Each step is tried whatever the other did. */
  async purge(): Promise<void> {
    const running = [...this.#active.values()];
    this.#active.clear();
    this.#records.dropAll();
    await Promise.all(running.map((t) => t.cancel().catch(() => undefined)));
    const journal = this.#journal.clear().catch(() => undefined);
    const cache = rm(join(this.#d.ctx.dirs.state, CLOUD_SYNC_CHUNKS_DIR), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    await Promise.all([journal, cache]);
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────

  /** The caller's progress callback, plus a `transferProgress` event. */
  #progress(id: string, opts: WriteOptions): WriteOptions {
    return {
      ...opts,
      onProgress: (done, total) => {
        opts.onProgress?.(done, total);
        this.#d.emit({ type: TransferEvent.transferprogress, id, done, total });
      },
    };
  }

  async #client(): Promise<SavesClient> {
    const { ctx, host, keyring } = this.#d;
    ctx.requireService("sync", Feature.syncSaves);
    await this.#d.attach();
    if (!host.started) throw new SavesError("rejected", "sync-not-started");
    const e2e = host.machine.encryptionMode() === "e2e";
    const codec: FileCodec = e2e
      ? keyring.fileCodec(SAVES_COLLECTION)
      : serverFileCodec(webCryptoSyncPort);
    const o = host.savesOptions;
    const subject = this.#d.subject();
    const cache =
      o.delta && subject !== null
        ? new FileChunkCache(
            chunkCacheDir(ctx.dirs.state, subject, SAVES_COLLECTION),
            chunkCacheBudget(o.maxBytes ?? 0),
          )
        : undefined;
    return new SavesClient({
      records: this.#records,
      engine: this.#engine,
      transport: this.#transport,
      codec,
      delta: o.delta,
      ...(cache ? { cache } : {}),
      ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}),
      ...(o.saveFormatVersion !== undefined
        ? { saveFormatVersion: o.saveFormatVersion }
        : {}),
    });
  }

  /** Register a write, emit its events, and drop it from `transfers()` when it settles. */
  #track(t: SaveTransfer): SaveTransfer {
    this.#active.set(t.id, t);
    const emit = this.#d.emit;
    void t.done.then((o: SaveOutcome) => {
      this.#active.delete(t.id);
      if (o.state === "failed")
        emit({
          type: TransferEvent.transferfailed,
          id: t.id,
          code: o.error.code,
        });
      else
        emit({
          type: TransferEvent.transferdone,
          id: t.id,
          state: o.state,
        });
    });
    return t;
  }
}
