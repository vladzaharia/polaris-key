// Cloud Sync saves in the browser (U-22.6; plans D-2, D-3, D-8, D-9, D-11): `cloudSync.saves`, the
// records of the `saves` collection with one file each, over client-core's `SavesClient` and
// `TransferEngine`.
//
// This module is the browser's host for those two:
//   - the record layer (`BrowserSaveRecords`, the `SaveRecords` port): the person's save records,
//     read by a pull from cursor 0 and written by a push of one mutation, both through
//     `sendSync` (the settings machine's own transport rules: the product's `/sync` routes only,
//     the device bearer, no cookie). In end-to-end mode every row is sealed and opened by the key
//     ring's host codec (`sealPush` / `openPull`): a row that is not sealed under this ring is not
//     a save. The machine is not used: a save's metadata `set` must answer its own conflict now
//     (D-3), where the machine queues and answers later. It has its own client id and mutation
//     counter (kept in the files database), so it never shares the machine's mutation ids.
//   - the file layer: `BrowserFileTransport`, the IndexedDB journal and the chunk cache (D-9),
//     and the file codec of the ring (`KeyringClient.fileCodec`).
//   - one writer: a transfer runs under the Web Lock `pkey-sync-files:<db>`, so two tabs never
//     drive the same journal. A tab that cannot take the lock waits its turn.
//
// A save's bytes are never stored here: the journal holds progress only, the cache holds chunk
// objects as stored (ciphertext in end-to-end mode).

import type { Json } from "@polaris-key/client-core/cloud-sync";
import {
  SavesClient,
  SavesError,
  TransferEngine,
  chunkCacheBudget,
  openPull,
  sealPush,
  serverFileCodec,
  webCryptoSyncPort,
  type FileCodec,
  type HostCodec,
  type RangedSource,
  type ReadOptions,
  type SaveConflict,
  type SaveFileRef,
  type SaveKeep,
  type SaveOutcome,
  type SaveRead,
  type SaveRecord,
  type SaveRecords,
  type SaveSetResult,
  type SaveSummary,
  type SaveTransfer,
  type TransferState,
  type WriteOptions,
} from "@polaris-key/client-core/sync";
import type { FileRevision } from "@polaris-key/protocol/sync";
import { Feature } from "../../constants.generated.js";
import { UnsupportedError } from "../../core/caps.js";
import { BrowserFileTransport, type FileFetch } from "./files.js";
import { filesDbName } from "./filesPurge.js";
import { filesStore, type FilesStore } from "./idbJournal.js";
import { sendSync, type ProductRequest } from "./transport.js";
import type { HostLocks } from "./host.js";

export const SAVES = "saves";
/** The longest `Retry-After` a transfer waits out (the Worker may answer a write 503). */
export const SAVES_MAX_RETRY_AFTER_SECONDS = 3600;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_PAGES = 64;
const META_CLIENT = "saves.client";

/** What an app declares about its saves; each falls back to the compiled catalog, then the template's. */
export interface SavesOptions {
  /** Send only the chunks that changed (the `saves` template's default). */
  delta?: boolean;
  /** The most bytes one save may hold. Default 32 MiB. */
  maxBytes?: number;
  /** The newest save format this build reads (D-11): a save above it reads as `newer-format`. */
  saveFormatVersion?: number;
}

/** The event stream of transfers (`transferEvent`). */
export type TransferEvent =
  | {
      type: "transferProgress";
      id: string;
      saveId: string;
      done: number;
      total: number;
    }
  | {
      type: "transferDone";
      id: string;
      saveId: string;
      /** How it ended: stored, released by the app, or a conflict the app must settle. */
      state: "done" | "cancelled" | "conflict";
    }
  | { type: "transferFailed"; id: string; saveId: string; code: string };

/** A write in flight, as `transfers()` lists it. */
export interface TransferInfo {
  id: string;
  saveId: string;
  state: TransferState;
  progress: { done: number; total: number };
}

/** A write the app holds: `SaveTransfer`, which also tells which save it is for. */
export interface BrowserTransfer extends SaveTransfer {
  readonly saveId: string;
}

/** `cloudSync.saves`. */
export interface SavesApi {
  list(): Promise<SaveSummary[]>;
  read(id: string, opts?: ReadOptions): Promise<SaveRead>;
  write(
    id: string,
    bytes: Uint8Array | RangedSource,
    metadata: { [k: string]: Json },
    opts?: WriteOptions,
  ): BrowserTransfer;
  /** Settle a conflict `write` ended with (`outcome.state === "conflict"`). */
  resolve(
    conflict: SaveConflict,
    keep: SaveKeep,
    bytes: Uint8Array | RangedSource,
    opts?: WriteOptions,
  ): BrowserTransfer;
  delete(id: string, baseVersion?: number): Promise<SaveSetResult>;
  revisions(id: string): Promise<FileRevision[]>;
  /** The writes in flight (and paused) in this tab. */
  transfers(): TransferInfo[];
  /** Transfer events, in order. Returns the unsubscribe. */
  onTransfer(listener: (event: TransferEvent) => void): () => void;
}

// ── The record layer ─────────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is { [k: string]: Json } =>
  v !== null && typeof v === "object" && !Array.isArray(v);

function newClientId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return `c_${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function pointer(v: unknown): SaveFileRef | null {
  if (!isObj(v)) return null;
  const { version, size, sha256, format } = v;
  if (
    typeof version === "number" &&
    Number.isSafeInteger(version) &&
    typeof size === "number" &&
    Number.isSafeInteger(size) &&
    typeof sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(sha256) &&
    (format === "whole" || format === "chunks")
  )
    return { version, size, sha256, format };
  return null;
}

export interface SaveRecordsDeps {
  product: string;
  request: ProductRequest;
  /** True in end-to-end mode: rows are sealed, and only a row this ring opened is a save. */
  e2e: () => boolean;
  codec: () => HostCodec | null;
  meta: FilesStore["meta"];
}

/** The `SaveRecords` port over the product's sync routes. */
export class BrowserSaveRecords implements SaveRecords {
  readonly #d: SaveRecordsDeps;
  #client: Promise<{ clientId: string; next: number }> | null = null;
  #cursor = 0;

  constructor(deps: SaveRecordsDeps) {
    this.#d = deps;
  }

  async wireId(id: string): Promise<string> {
    if (!this.#d.e2e()) return id;
    const codec = this.#d.codec();
    if (codec === null || codec.locked) throw lockedError();
    return codec.blind("record", SAVES, id);
  }

  /** The client id and the next mutation id, reserved (persisted) before use so none repeats. */
  async #reserve(): Promise<{ clientId: string; mutationId: number }> {
    this.#client ??= (async () => {
      const v = await this.#d.meta.get(META_CLIENT);
      if (
        isObj(v) &&
        typeof v.clientId === "string" &&
        Number.isSafeInteger(v.next) &&
        (v.next as number) >= 1
      )
        return { clientId: v.clientId, next: v.next as number };
      return { clientId: newClientId(), next: 1 };
    })();
    const c = await this.#client;
    const mutationId = c.next;
    c.next += 1;
    await this.#d.meta.put(META_CLIENT, { clientId: c.clientId, next: c.next });
    return { clientId: c.clientId, mutationId };
  }

  /** Every save record of the person: a snapshot pull, page by page. */
  async #snapshot(): Promise<SaveRecord[]> {
    const rows = new Map<string, SaveRecord>();
    let cursor = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await sendSync(this.#d.product, this.#d.request, {
        method: "GET",
        path: `/${this.#d.product}/sync?cursor=${cursor}`,
      });
      if (!("status" in res) || res.status !== 200 || !isObj(res.body))
        throw new SavesRecordsError("sync-failed");
      let body: Json = res.body;
      let opened: Awaited<ReturnType<typeof openPull>>["opened"] = {};
      if (this.#d.e2e()) {
        const codec = this.#d.codec();
        if (codec === null || codec.locked) throw lockedError();
        const o = await openPull(body, codec, {
          recordKeys: [...rows.keys()].map((id) => [SAVES, id] as const),
        });
        body = o.body;
        opened = o.opened;
      }
      const b = body as { [k: string]: Json };
      const changes = Array.isArray(b.changes) ? b.changes : [];
      changes.forEach((c, i) => {
        if (!isObj(c) || !Array.isArray(c.record)) return;
        const [coll, id] = c.record;
        if (coll !== SAVES || typeof id !== "string") return;
        if (typeof c.version !== "number") return;
        if (this.#d.e2e()) {
          // Only a row this ring opened is a save; a plaintext or unreadable one is not.
          if (opened.changes?.[i]?.sealed !== true) return;
        }
        const value = isObj(c.value) ? c.value : this.#d.e2e() ? null : {};
        if (value === null) return;
        rows.set(id, {
          id,
          version: c.version,
          value: value as { [k: string]: Json },
          file: pointer(c.file),
        });
      });
      for (const t of Array.isArray(b.tombstones) ? b.tombstones : []) {
        if (!isObj(t) || !Array.isArray(t.record)) continue;
        if (t.record[0] === SAVES && typeof t.record[1] === "string")
          rows.delete(t.record[1]);
      }
      if (typeof b.cursor === "number") {
        cursor = b.cursor;
        this.#cursor = b.cursor;
      }
      if (b.more !== true) return [...rows.values()];
    }
    throw new SavesRecordsError("sync-failed");
  }

  list(): Promise<SaveRecord[]> {
    return this.#snapshot();
  }

  async get(id: string): Promise<SaveRecord | null> {
    return (await this.#snapshot()).find((r) => r.id === id) ?? null;
  }

  set(
    id: string,
    value: { [k: string]: Json },
    baseVersion: number | "*",
  ): Promise<SaveSetResult> {
    return this.#push(id, { op: "set", value }, baseVersion);
  }

  delete(id: string, baseVersion: number): Promise<SaveSetResult> {
    return this.#push(id, { op: "delete" }, baseVersion);
  }

  async #push(
    id: string,
    what: { op: "set"; value: { [k: string]: Json } } | { op: "delete" },
    baseVersion: number | "*",
  ): Promise<SaveSetResult> {
    const { clientId, mutationId } = await this.#reserve();
    const mutation = {
      mutationId,
      target: { record: [SAVES, id] },
      op: what.op,
      ...(what.op === "set" ? { value: what.value } : {}),
      baseVersion,
    };
    let body: Json = {
      clientId,
      cursor: this.#cursor,
      atomic: false,
      mutations: [mutation as unknown as Json],
    };
    const e2e = this.#d.e2e();
    const codec = this.#d.codec();
    if (e2e) {
      if (codec === null || codec.locked) throw lockedError();
      body = await sealPush(body, codec, []);
    }
    const res = await sendSync(this.#d.product, this.#d.request, {
      method: "POST",
      path: `/${this.#d.product}/sync/ops`,
      body,
    });
    if (!("status" in res)) throw new SavesRecordsError("sync-failed");
    if (res.status === 403 || res.status === 429 || res.status >= 400)
      return {
        ok: false,
        reason: "rejected",
        code: codeOf(res.body, res.status),
      };
    if (!isObj(res.body) || !Array.isArray(res.body.results))
      throw new SavesRecordsError("sync-failed");
    const r = res.body.results.find(
      (x) => isObj(x) && x.mutationId === mutationId,
    );
    if (!isObj(r)) throw new SavesRecordsError("sync-failed");
    switch (r.status) {
      case "ok":
        return typeof r.version === "number"
          ? { ok: true, version: r.version }
          : { ok: false, reason: "rejected", code: "bad_response" };
      case "conflict":
        return {
          ok: false,
          reason: "conflict",
          server: await this.#serverCopy(res.body, id, mutation),
        };
      case "duplicate": {
        // The mutation id was already applied: read the record back for its version.
        const rec = await this.get(id);
        return rec
          ? { ok: true, version: rec.version }
          : { ok: false, reason: "rejected", code: "duplicate" };
      }
      default:
        return {
          ok: false,
          reason: "rejected",
          code: typeof r.code === "string" ? r.code : "rejected",
        };
    }
  }

  /** The record the Worker holds, from a conflict's `server` copy; null when it cannot be read. */
  async #serverCopy(
    body: { [k: string]: Json },
    id: string,
    mutation: { mutationId: number },
  ): Promise<SaveRecord | null> {
    let answer: Json = body;
    let sealed = false;
    if (this.#d.e2e()) {
      const codec = this.#d.codec();
      if (codec === null || codec.locked) throw lockedError();
      const o = await openPull(body, codec, {
        mutations: [
          {
            mutationId: mutation.mutationId,
            target: { record: [SAVES, id] },
            op: "set",
          },
        ],
      });
      answer = o.body;
      sealed = o.opened.conflicts?.[mutation.mutationId]?.sealed === true;
    }
    const results = (answer as { [k: string]: Json }).results;
    const r = Array.isArray(results)
      ? results.find((x) => isObj(x) && x.mutationId === mutation.mutationId)
      : undefined;
    const server = isObj(r) && isObj(r.server) ? r.server : null;
    if (server === null || typeof server.version !== "number") return null;
    if (this.#d.e2e() && !sealed) return null;
    return {
      id,
      version: server.version,
      value: isObj(server.value) ? (server.value as { [k: string]: Json }) : {},
      file: pointer(server.file),
    };
  }
}

function codeOf(body: unknown, status: number): string {
  if (isObj(body)) {
    const e = body.error;
    if (typeof e === "string" && e !== "") return e;
    if (isObj(e) && typeof e.code === "string") return e.code;
  }
  return status === 401 ? "unauthorized" : "request_failed";
}

/** A save record call that got no usable answer. The app sees `transfer-failed`/`rejected` where it matters. */
export class SavesRecordsError extends Error {
  constructor(readonly code: "sync-failed") {
    super(`saves records: ${code}`);
    this.name = "SavesRecordsError";
  }
}

function lockedError(): Error {
  return Object.assign(new Error("Cloud Sync is locked: there is no root"), {
    code: "sync-locked",
  });
}

// ── The assembled API ────────────────────────────────────────────────────────────────────────

export interface BrowserSavesDeps {
  product: string;
  /** The settings record's database name; the files database is its neighbour. */
  dbName: string;
  request: ProductRequest;
  fileFetch: FileFetch;
  /** `"e2e"` or `"server"`, as the machine settled it. */
  encryption: () => "e2e" | "server" | "omitted";
  ring: {
    codec(): HostCodec | null;
    fileCodec?(collection: string): Promise<FileCodec | null>;
  };
  locks: HostLocks;
  options: SavesOptions;
  /** Test seams. */
  store?: FilesStore;
  newTransferId?: (saveId: string) => string;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** A transfer that runs under the files lock and can be paused, resumed and cancelled before and after it holds it. */
class LockedTransfer implements BrowserTransfer {
  readonly done: Promise<SaveOutcome>;
  #inner: SaveTransfer | null = null;
  #early: "pause" | "cancel" | null = null;
  #state: TransferState = "running";
  progress = { done: 0, total: 0 };

  constructor(
    readonly id: string,
    readonly saveId: string,
    start: () => SaveTransfer,
    locks: HostLocks,
    lockName: string,
    private readonly finish: (o: SaveOutcome) => void,
  ) {
    this.done = new Promise<SaveOutcome>((resolve) => {
      const run = async (): Promise<void> => {
        if (this.#early === "cancel") {
          this.#state = "cancelled";
          resolve({ state: "cancelled" });
          return;
        }
        const inner = start();
        this.#inner = inner;
        if (this.#early === "pause") inner.pause();
        resolve(await inner.done);
      };
      void locks.request(lockName, run).catch(() =>
        resolve({
          state: "failed",
          error: new SavesError("transfer-failed", "lock"),
        }),
      );
    }).then((o) => {
      this.#state = o.state === "done" ? "done" : o.state;
      this.finish(o);
      return o;
    });
  }

  get state(): TransferState {
    return this.#inner?.state ?? this.#state;
  }

  pause(): void {
    if (this.#inner) this.#inner.pause();
    else this.#early = "pause";
  }

  resume(): void {
    if (this.#inner) this.#inner.resume();
    else if (this.#early === "pause") this.#early = null;
  }

  async cancel(): Promise<void> {
    if (this.#inner) await this.#inner.cancel();
    else this.#early = "cancel";
    await this.done;
  }
}

/** Builds the saves API for one adapter. Throws the typed unsupported where files cannot run. */
export function createBrowserSaves(d: BrowserSavesDeps): SavesApi & {
  /** Delete the journal and the chunk cache (with the person). */
  purge(): Promise<void>;
} {
  // Read on each call: the machine may settle the mode after this was built. Unknown is end-to-end.
  const e2e = (): boolean => d.encryption() !== "server";
  const delta = d.options.delta ?? true;
  const maxBytes = d.options.maxBytes ?? DEFAULT_MAX_BYTES;
  const store =
    d.store ?? filesStore(filesDbName(d.dbName), chunkCacheBudget(maxBytes));
  const transport = new BrowserFileTransport({
    product: d.product,
    request: d.fileFetch,
  });
  const engine = new TransferEngine({
    transport,
    journal: store.journal,
    maxRetryAfterSeconds: SAVES_MAX_RETRY_AFTER_SECONDS,
    ...(d.sleep ? { sleep: d.sleep } : {}),
  });
  const records = new BrowserSaveRecords({
    product: d.product,
    request: d.request,
    e2e,
    codec: () => d.ring.codec(),
    meta: store.meta,
  });
  const lockName = `pkey-sync-files:${d.dbName}`;
  const active = new Map<string, BrowserTransfer>();
  const listeners = new Set<(e: TransferEvent) => void>();
  const emit = (e: TransferEvent): void => {
    for (const l of [...listeners]) {
      try {
        l(e);
      } catch {
        // A listener's failure never reaches the transfer.
      }
    }
  };

  /** The file codec for one operation: the ring's (end-to-end) or the plain one (server mode). */
  const codec = async (): Promise<FileCodec> => {
    if (!e2e()) return serverFileCodec(webCryptoSyncPort);
    const c = (await d.ring.fileCodec?.(SAVES)) ?? null;
    // No root: the ring is locked (or never made), so nothing is sealed and nothing is sent.
    if (c === null) throw new SavesError("transfer-failed", "sync-locked");
    return c;
  };

  const client = (fc: FileCodec): SavesClient =>
    new SavesClient({
      records,
      engine,
      transport,
      codec: fc,
      delta,
      cache: store.cache,
      maxBytes,
      ...(d.options.saveFormatVersion !== undefined
        ? { saveFormatVersion: d.options.saveFormatVersion }
        : {}),
      ...(d.newTransferId ? { newTransferId: d.newTransferId } : {}),
    });

  const track = (
    saveId: string,
    start: (fc: FileCodec, opts: WriteOptions) => SaveTransfer,
    opts: WriteOptions,
  ): BrowserTransfer => {
    const id = (d.newTransferId ?? ((s: string) => `saves:${s}`))(saveId);
    let t!: LockedTransfer;
    const onProgress = (done: number, total: number): void => {
      t.progress = { done, total };
      opts.onProgress?.(done, total);
      emit({ type: "transferProgress", id, saveId, done, total });
    };
    t = new LockedTransfer(
      id,
      saveId,
      () => {
        // The codec is built when the lock is held, so a ring locked while this waited stops it.
        let inner!: SaveTransfer;
        const pending = codec().then((fc) => {
          inner = start(fc, { ...opts, onProgress });
          return inner;
        });
        return deferred(id, pending);
      },
      d.locks,
      lockName,
      (o) => {
        active.delete(id);
        if (o.state === "failed")
          emit({ type: "transferFailed", id, saveId, code: o.error.code });
        else emit({ type: "transferDone", id, saveId, state: o.state });
      },
    );
    active.set(id, t);
    return t;
  };

  return {
    async list() {
      return client(await codec()).list();
    },
    async read(id, opts) {
      return client(await codec()).read(id, opts);
    },
    write: (id, bytes, metadata, opts = {}) =>
      track(id, (fc, o) => client(fc).write(id, bytes, metadata, o), opts),
    resolve: (conflict, keep, bytes, opts = {}) =>
      track(
        conflict.id,
        (fc, o) => client(fc).resolve(conflict, keep, bytes, o),
        opts,
      ),
    async delete(id, baseVersion) {
      return client(await codec()).delete(id, baseVersion);
    },
    async revisions(id) {
      return client(await codec()).revisions(id);
    },
    transfers: () =>
      [...active.values()].map((t) => ({
        id: t.id,
        saveId: t.saveId,
        state: t.state,
        progress: { ...t.progress },
      })),
    onTransfer(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async purge() {
      for (const t of [...active.values()]) await t.cancel().catch(() => {});
      await store.purge();
    },
  };
}

/** A `SaveTransfer` whose engine handle arrives once the (async) codec is ready. */
function deferred(id: string, pending: Promise<SaveTransfer>): SaveTransfer {
  let inner: SaveTransfer | null = null;
  let early: "pause" | "cancel" | null = null;
  const done = pending.then(
    (t) => {
      inner = t;
      if (early === "pause") t.pause();
      if (early === "cancel") void t.cancel();
      return t.done;
    },
    (e): SaveOutcome => ({
      state: "failed",
      error:
        e instanceof SavesError
          ? e
          : new SavesError("transfer-failed", "sync-locked", e),
    }),
  );
  return {
    id,
    get state() {
      return inner?.state ?? "running";
    },
    get progress() {
      return inner?.progress ?? { done: 0, total: 0 };
    },
    pause: () => (inner ? inner.pause() : void (early = "pause")),
    resume: () => (inner ? inner.resume() : void (early = null)),
    cancel: async () => {
      if (inner) await inner.cancel();
      else early = "cancel";
      await done;
    },
    done,
  };
}

/** The typed unsupported a saves call gets where files cannot run. */
export function savesUnsupported(detail: string): UnsupportedError {
  return new UnsupportedError({
    supported: false,
    feature: Feature.syncSaves,
    reason: "runtime",
    detail,
  });
}
