// The receiver's partial transfers in the browser (CC-20.4; WIRE-CONTRACT-V5 §15.11, "Resume" and
// "The name is display data"), kept in one IndexedDB database per product:
//
//   meta    key = ref         {v, peer, id, sha256, size, chunk, at}
//   parts   key = [ref, off]  the bytes written at that offset (one record per CHUNK)
//
// Rules this module keeps:
//  - a partial is named by `ref` only: the 64 hex characters client-core derives from the peer key,
//    the transfer id and the hash. The peer's `name` never reaches a key, and a `ref` that is not
//    64 lowercase hex characters is refused before the database is touched;
//  - a partial older than 24 h from its last write, and the oldest ones past `maxFiles`, are
//    removed; the bytes the store may still take come from the storage estimate (kept current
//    by every write) and are answered synchronously to the machine;
//  - the peer's key is held as its hex form in the partial's record only, as the resume key
//    needs it; the record is removed with the partial;
//  - content leaves only through `read`/`blob`, once the machine says the hash matched, and
//    the partial is removed after the host's sink took it;
//  - `purgeAll` deletes the whole database (sign-out, deactivation).

import {
  XFER_PARTIAL_SECONDS,
  XferHasher,
  type XferPartial,
} from "@polaris-key/client-core/peer";

import { hex } from "./bytes.js";

const REF = /^[0-9a-f]{64}$/;
const META = "meta";
const PARTS = "parts";

/** The most partial transfers held for all peers together. */
export const XFER_STORE_MAX_FILES = 64;
/** What the store assumes it may use when the browser gives no estimate. */
export const XFER_STORE_FALLBACK_BYTES = 512 * 1024 ** 2;
/** The share of the estimated free space the store may fill. */
const SHARE = 0.8;
/** The block a spooled stream is kept in. */
export const SPOOL_BLOCK = 1024 * 1024;
/** A record of the last write is flushed at most this often (ms). */
const TOUCH_MS = 10_000;

interface Meta {
  v: 1;
  peer: string;
  id: string;
  sha256: string;
  size: number;
  chunk: number;
  /** Milliseconds since the epoch of the last write. */
  at: number;
}

export interface XferStoreOptions {
  idb?: IDBFactory | undefined;
  /** Milliseconds since the epoch. */
  now?: () => number;
  maxFiles?: number;
  /** The storage estimate; default `navigator.storage.estimate`. */
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
}

export class XferStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XferStoreError";
  }
}

const HEX = hex;
const done = <T>(tx: IDBTransaction, get: () => T): Promise<T> =>
  new Promise<T>((res, rej) => {
    tx.oncomplete = () => res(get());
    tx.onerror = () => rej(tx.error ?? new Error("indexeddb"));
    tx.onabort = () => rej(tx.error ?? new Error("indexeddb"));
  });

const result = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise<T>((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error ?? new Error("indexeddb"));
  });

const span = (ref: string, from = 0): IDBKeyRange =>
  IDBKeyRange.bound([ref, from], [ref, Infinity]);

export class XferStore {
  readonly #name: string;
  readonly #idb: IDBFactory | undefined;
  readonly #now: () => number;
  readonly #maxFiles: number;
  readonly #estimate: () => Promise<{ quota?: number; usage?: number }>;
  #db: Promise<IDBDatabase> | null = null;
  #ready: Promise<void> | null = null;
  readonly #reserved = new Map<string, number>();
  readonly #bound = new Map<string, string>();
  #protect: (ref: string) => boolean = () => false;
  /** Bumped by every purge. */
  #gen = 0;
  /** Bytes the store may still take, kept current by the writes. */
  #room = XFER_STORE_FALLBACK_BYTES;
  #sinceEstimate = 0;
  readonly #metas = new Map<string, Meta>();
  readonly #touched = new Map<string, number>();

  constructor(name: string, o: XferStoreOptions = {}) {
    this.#name = name;
    this.#idb =
      "idb" in o ? o.idb : (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    this.#now = o.now ?? Date.now;
    this.#maxFiles = o.maxFiles ?? XFER_STORE_MAX_FILES;
    this.#estimate =
      o.estimate ??
      (async () =>
        (
          globalThis as {
            navigator?: {
              storage?: {
                estimate?: () => Promise<{ quota?: number; usage?: number }>;
              };
            };
          }
        ).navigator?.storage?.estimate?.() ?? {});
  }

  get name(): string {
    return this.#name;
  }

  /** Whether this browser can keep partial transfers at all. */
  get available(): boolean {
    return this.#idb !== undefined;
  }

  /** The connection, for work begun in generation `g`: after a purge, older work is refused so a
   *  late effect cannot bring the database back. */
  async #open(g: number): Promise<IDBDatabase> {
    if (g !== this.#gen) throw new XferStoreError("purged");
    const d = await this.#connect();
    if (g !== this.#gen) throw new XferStoreError("purged");
    return d;
  }

  #connect(): Promise<IDBDatabase> {
    const idb = this.#idb;
    if (idb === undefined)
      return Promise.reject(new XferStoreError("no indexeddb"));
    const p = (this.#db ??= new Promise<IDBDatabase>((res, rej) => {
      const r = idb.open(this.#name, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore(META);
        r.result.createObjectStore(PARTS);
      };
      r.onsuccess = () => {
        const d = r.result;
        d.onclose = () => {
          if (this.#db === p) this.#db = null;
        };
        d.onversionchange = () => {
          d.close();
          if (this.#db === p) this.#db = null;
        };
        res(d);
      };
      r.onerror = () => rej(r.error ?? new Error("indexeddb"));
      r.onblocked = () => rej(new Error("indexeddb blocked"));
    }));
    p.catch(() => {
      if (this.#db === p) this.#db = null;
    });
    return p;
  }

  #ref(ref: string): string {
    if (!REF.test(ref)) throw new XferStoreError("bad partial reference");
    return ref;
  }

  /** Open the database, drop what is stale and read the estimate. Safe to call again. */
  ready(): Promise<void> {
    const g = this.#gen;
    this.#ready ??= (async () => {
      await this.#open(g);
      await this.#scan(g);
      await this.refreshRoom();
    })().catch((e: unknown) => {
      this.#ready = null;
      throw e;
    });
    return this.#ready;
  }

  async #scan(g: number): Promise<void> {
    const d = await this.#open(g);
    const tx = d.transaction(META, "readonly");
    const keys = await result(tx.objectStore(META).getAllKeys());
    const vals = await result(tx.objectStore(META).getAll());
    this.#metas.clear();
    const stale: string[] = [];
    const now = this.#now();
    keys.forEach((k, i) => {
      const m = vals[i] as Meta | undefined;
      const ref = String(k);
      if (
        !REF.test(ref) ||
        m === undefined ||
        m.v !== 1 ||
        typeof m.peer !== "string" ||
        typeof m.id !== "string" ||
        typeof m.sha256 !== "string" ||
        !Number.isSafeInteger(m.size) ||
        !Number.isSafeInteger(m.chunk) ||
        !Number.isFinite(m.at) ||
        now - m.at > XFER_PARTIAL_SECONDS * 1000
      )
        stale.push(ref);
      else this.#metas.set(ref, m);
    });
    for (const ref of stale) await this.#drop(ref, g);
    // Bytes with no record are a crash's leftovers (a spooled stream keeps its own for a day).
    const pk = await result(
      d.transaction(PARTS, "readonly").objectStore(PARTS).getAllKeys(),
    );
    const orphans = new Set<string>();
    for (const k of pk) {
      const ref = (k as [string, number])[0];
      if (this.#metas.has(ref)) continue;
      const sp = /^spool-(\d+)-/.exec(ref);
      if (sp !== null && now - Number(sp[1]) < XFER_PARTIAL_SECONDS * 1000)
        continue;
      orphans.add(ref);
    }
    for (const ref of orphans) await this.#drop(ref, g);
    while (this.#metas.size > this.#maxFiles && (await this.#evictOldest(g)));
  }

  /** Drop the oldest partial no live transfer holds; false when there is none. */
  async #evictOldest(g: number): Promise<boolean> {
    let oldest: { ref: string; at: number } | null = null;
    for (const [ref, m] of this.#metas) {
      if (this.#protect(ref)) continue;
      if (oldest === null || m.at < oldest.at) oldest = { ref, at: m.at };
    }
    if (oldest === null) return false;
    await this.#drop(oldest.ref, g);
    return true;
  }

  /** Read the storage estimate again (the quota the browser gives this origin). */
  async refreshRoom(): Promise<void> {
    this.#sinceEstimate = 0;
    try {
      const e = await this.#estimate();
      if (typeof e.quota === "number" && e.quota > 0) {
        const left = Math.max(0, e.quota - (e.usage ?? 0));
        this.#room = Math.floor(left * SHARE);
        return;
      }
    } catch {
      // no estimate: the fallback stands
    }
    this.#room = XFER_STORE_FALLBACK_BYTES;
  }

  /** Bytes the store can still take: the estimate and the writes since, less what accepted
   *  transfers have reserved. */
  free(): number {
    let held = 0;
    for (const n of this.#reserved.values()) held += n;
    return Math.max(0, this.#room - held);
  }

  /** Set aside `bytes` for an accepted transfer; false (nothing reserved) when they do not fit. */
  reserve(key: string, bytes: number): boolean {
    this.release(key);
    if (bytes > this.free()) return false;
    this.#reserved.set(key, bytes);
    return true;
  }

  /** The partial `ref` is the one the reservation `key` was made for: its writes use it up. */
  bind(ref: string, key: string): void {
    if (this.#reserved.has(key)) this.#bound.set(ref, key);
  }

  release(key: string): void {
    this.#reserved.delete(key);
    for (const [ref, k] of [...this.#bound])
      if (k === key) this.#bound.delete(ref);
  }

  /** Partials this says are held by a live transfer are never evicted. */
  protect(fn: (ref: string) => boolean): void {
    this.#protect = fn;
  }

  async #bytesOf(ref: string, g: number): Promise<number> {
    const d = await this.#open(g);
    const tx = d.transaction(PARTS, "readonly");
    const cur = await result(
      tx.objectStore(PARTS).openCursor(span(ref), "prev"),
    );
    if (cur === null) return 0;
    const key = cur.key as [string, number];
    return key[1] + (cur.value as Uint8Array).length;
  }

  /** The kept partials of one peer key, ages in seconds since the last write. */
  async list(
    peerKey: Uint8Array,
  ): Promise<(Omit<XferPartial, "writtenAt" | "held"> & { age: number })[]> {
    const g = this.#gen;
    await this.ready();
    const peer = HEX(peerKey);
    const out: (Omit<XferPartial, "writtenAt" | "held"> & {
      age: number;
    })[] = [];
    for (const [ref, m] of [...this.#metas]) {
      if (m.peer !== peer) continue;
      out.push({
        ref,
        id: m.id,
        sha256: m.sha256,
        size: m.size,
        chunk: m.chunk,
        bytes: await this.#bytesOf(ref, g),
        age: Math.max(0, (this.#now() - m.at) / 1000),
      });
    }
    return out;
  }

  /** The id and hash a kept partial was made for. */
  metaOf(ref: string): { id: string; sha256: string } | null {
    const m = this.#metas.get(this.#ref(ref));
    return m === undefined ? null : { id: m.id, sha256: m.sha256 };
  }

  // ── effects ────────────────────────────────────────────────────────────────

  async create(
    ref: string,
    peerKey: Uint8Array,
    p: XferPartial,
  ): Promise<void> {
    this.#ref(ref);
    const g = this.#gen;
    const d = await this.#open(g);
    await this.#drop(ref, g);
    while (this.#metas.size >= this.#maxFiles)
      if (!(await this.#evictOldest(g))) throw new XferStoreError("no room");
    const meta: Meta = {
      v: 1,
      peer: HEX(peerKey),
      id: p.id,
      sha256: p.sha256,
      size: p.size,
      chunk: p.chunk,
      at: this.#now(),
    };
    const tx = d.transaction(META, "readwrite");
    tx.objectStore(META).put(meta, ref);
    await done(tx, () => undefined);
    this.#metas.set(ref, meta);
    this.#touched.set(ref, this.#now());
  }

  /** Cut a kept partial back to `to` bytes (the verified offset). */
  async truncate(ref: string, to: number): Promise<void> {
    this.#ref(ref);
    if (!this.#metas.has(ref)) throw new XferStoreError("unknown partial");
    const g = this.#gen;
    const d = await this.#open(g);
    const tx = d.transaction(PARTS, "readwrite");
    const store = tx.objectStore(PARTS);
    // A record that starts before `to` and ends after it is cut; the rest past `to` goes.
    const before = await result(
      store.openCursor(
        IDBKeyRange.bound([ref, 0], [ref, to], false, true),
        "prev",
      ),
    );
    if (before !== null) {
      const off = (before.key as [string, number])[1];
      const v = before.value as Uint8Array;
      if (off + v.length > to) store.put(v.slice(0, to - off), [ref, off]);
    }
    store.delete(span(ref, to));
    await done(tx, () => undefined);
    await this.refreshRoom();
  }

  async write(ref: string, offset: number, data: Uint8Array): Promise<void> {
    this.#ref(ref);
    const meta = this.#metas.get(ref);
    if (meta === undefined) throw new XferStoreError("unknown partial");
    // Never past what was offered, and never past what the browser said it would hold.
    if (offset + data.length > meta.size || data.length > this.#room)
      throw new XferStoreError("no room");
    const g = this.#gen;
    const d = await this.#open(g);
    const tx = d.transaction(PARTS, "readwrite");
    tx.objectStore(PARTS).put(data.slice(), [ref, offset]);
    await done(tx, () => undefined);
    this.#room = Math.max(0, this.#room - data.length);
    const key = this.#bound.get(ref);
    if (key !== undefined)
      this.#reserved.set(
        key,
        Math.max(0, (this.#reserved.get(key) ?? 0) - data.length),
      );
    this.#sinceEstimate += data.length;
    await this.#touch(ref, g);
    if (this.#sinceEstimate >= 32 * 1024 ** 2) await this.refreshRoom();
  }

  async #touch(ref: string, g: number, force = false): Promise<void> {
    const m = this.#metas.get(ref);
    if (m === undefined) return;
    const now = this.#now();
    if (!force && now - (this.#touched.get(ref) ?? 0) < TOUCH_MS) return;
    this.#touched.set(ref, now);
    const next: Meta = { ...m, at: now };
    this.#metas.set(ref, next);
    const d = await this.#open(g);
    const tx = d.transaction(META, "readwrite");
    tx.objectStore(META).put(next, ref);
    await done(tx, () => undefined);
  }

  /** The session ended; the partial waits for a resume. */
  async keep(ref: string): Promise<void> {
    await this.#touch(this.#ref(ref), this.#gen, true).catch(() => undefined);
  }

  /** Remove a partial and its record. */
  async remove(ref: string): Promise<void> {
    await this.#drop(this.#ref(ref), this.#gen);
    await this.refreshRoom();
  }

  async #drop(ref: string, g: number): Promise<void> {
    this.#metas.delete(ref);
    this.#touched.delete(ref);
    const d = await this.#open(g);
    const tx = d.transaction([META, PARTS], "readwrite");
    tx.objectStore(META).delete(ref);
    tx.objectStore(PARTS).delete(span(ref));
    await done(tx, () => undefined);
  }

  /**
   * Re-read a kept partial from its start to the largest multiple of its chunk size that it holds
   * whole and in order, hashing as it goes. The machine asks for a hasher synchronously in the
   * middle of an `ACCEPT`, so the session gets this before it reads its first record.
   */
  async reread(
    ref: string,
    chunk: number,
    bytes: number,
  ): Promise<{ offset: number; hasher: XferHasher }> {
    this.#ref(ref);
    const want = Math.floor(bytes / chunk) * chunk;
    const hasher = new XferHasher();
    let at = 0;
    for await (const part of this.read(ref)) {
      if (at + part.length > want) {
        if (at < want) {
          hasher.update(part.subarray(0, want - at));
          at = want;
        }
        break;
      }
      hasher.update(part);
      at += part.length;
      if (at === want) break;
    }
    if (at !== want) throw new XferStoreError("the partial is short");
    return { offset: want, hasher };
  }

  // ── delivery ───────────────────────────────────────────────────────────────

  /** The kept bytes, in order, one record at a time. A gap is an error. */
  async *read(ref: string): AsyncGenerator<Uint8Array> {
    this.#ref(ref);
    const g = this.#gen;
    const d = await this.#open(g);
    let next = 0;
    let after: [string, number] | null = null;
    for (;;) {
      const tx = d.transaction(PARTS, "readonly");
      const range: IDBKeyRange =
        after === null
          ? span(ref)
          : IDBKeyRange.bound(after, [ref, Infinity], true, false);
      const got = await result(tx.objectStore(PARTS).openCursor(range));
      if (got === null) return;
      const off = (got.key as [string, number])[1];
      const v = new Uint8Array(got.value as Uint8Array);
      if (off !== next) throw new XferStoreError("the partial has a gap");
      next = off + v.length;
      after = [ref, off];
      yield v;
    }
  }

  /** Everything kept, as one Blob (the host's sink takes it). */
  async blob(ref: string, type?: string): Promise<Blob> {
    const parts: Uint8Array[] = [];
    for await (const p of this.read(ref)) parts.push(p);
    return new Blob(parts as BlobPart[], type === undefined ? {} : { type });
  }

  // ── spooled streams (the sender hashes a one-pass stream before it offers it) ─────────────

  /** A name for a spooled stream; `spoolWrite` and `spoolRead` work in blocks of `SPOOL_BLOCK`. */
  async spoolStart(): Promise<string> {
    await this.ready();
    const rnd = crypto.getRandomValues(new Uint8Array(16));
    return `spool-${this.#now()}-${HEX(rnd)}`;
  }

  async spoolWrite(
    ref: string,
    index: number,
    block: Uint8Array,
  ): Promise<void> {
    if (!/^spool-\d+-[0-9a-f]{32}$/.test(ref))
      throw new XferStoreError("bad spool reference");
    const d = await this.#open(this.#gen);
    const tx = d.transaction(PARTS, "readwrite");
    tx.objectStore(PARTS).put(block.slice(), [ref, index * SPOOL_BLOCK]);
    await done(tx, () => undefined);
  }

  async spoolRead(
    ref: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    if (!/^spool-\d+-[0-9a-f]{32}$/.test(ref))
      throw new XferStoreError("bad spool reference");
    const d = await this.#open(this.#gen);
    const out = new Uint8Array(length);
    let got = 0;
    while (got < length) {
      const at = offset + got;
      const base = at - (at % SPOOL_BLOCK);
      const tx = d.transaction(PARTS, "readonly");
      const v = (await result(tx.objectStore(PARTS).get([ref, base]))) as
        | Uint8Array
        | undefined;
      if (v === undefined || v.length <= at - base)
        throw new XferStoreError("the spooled stream is short");
      const take = Math.min(length - got, v.length - (at - base));
      out.set(v.subarray(at - base, at - base + take), got);
      got += take;
    }
    return out;
  }

  async spoolDrop(ref: string): Promise<void> {
    if (!/^spool-\d+-[0-9a-f]{32}$/.test(ref)) return;
    const d = await this.#open(this.#gen);
    const tx = d.transaction(PARTS, "readwrite");
    tx.objectStore(PARTS).delete(span(ref));
    await done(tx, () => undefined);
  }

  // ── forgetting ─────────────────────────────────────────────────────────────

  /** Remove every partial of one peer key (a deleted link or a revoked device). */
  async purgePeer(peerKey: Uint8Array): Promise<void> {
    if (!this.available) return;
    const g = this.#gen;
    await this.ready();
    const peer = HEX(peerKey);
    for (const [ref, m] of [...this.#metas])
      if (m.peer === peer) await this.#drop(ref, g);
  }

  /** Delete the whole database (sign-out, deactivation). Nothing is left behind. */
  async purgeAll(): Promise<void> {
    const idb = this.#idb;
    if (idb === undefined) return;
    this.#gen++;
    this.#reserved.clear();
    this.#bound.clear();
    const open = this.#db;
    this.#db = null;
    this.#ready = null;
    this.#metas.clear();
    this.#touched.clear();
    if (open !== null) (await open.catch(() => null))?.close();
    await new Promise<void>((res, rej) => {
      const r = idb.deleteDatabase(this.#name);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error ?? new Error("indexeddb"));
      r.onblocked = () => res();
    });
  }
}

/**
 * Remove the database for a sign-out without opening it first: nothing is created for an app that
 * never received a transfer. Fails closed: only a `databases()` list that confirms the database is
 * absent lets this skip it.
 */
export async function purgeXferStore(
  name: string,
  idb: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory })
    .indexedDB,
): Promise<void> {
  if (idb === undefined) return;
  if (typeof idb.databases === "function") {
    try {
      if (!(await idb.databases()).some((d) => d.name === name)) return;
    } catch {
      // may hold: delete
    }
  }
  await new XferStore(name, { idb }).purgeAll();
}
