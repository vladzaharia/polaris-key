// The Cloud Sync chunk cache on disk (U-22.4, plan D-9): the `ChunkCache` port of client-core's
// transfer engine. It holds chunk objects as stored (ciphertext in E2E mode, never plaintext), one
// file per object.
//
//   Names    an entry is named by its chunk id and nothing else, and only a 64-character lowercase
//            hex id is accepted (`isChunkCacheId`): no server text, collection name or save id ever
//            reaches a file name. A name in the directory that is not such an id is ignored (and a
//            stray temporary file is removed on the first scan).
//   Scope    one directory per (product, subject, collection): `chunkCacheDir` hashes the subject
//            and the collection into the path, so one person's chunks never serve another's and a
//            collection name cannot climb out of the cache root.
//   Budget   an LRU of at most `maxBytes` (default `chunkCacheBudget`): a read or a write marks the
//            entry newest, and the oldest go first when a write passes the budget. An object over
//            the budget is not kept.
//   Mode     directories 0700, files 0600, written atomically. `clear()` removes the directory: the
//            purge that goes with the person.
//   Backup   there is no portable way to keep a Node file out of an OS backup. The state directory
//            is the host's choice; put it where the platform does not back up (a cache or temp
//            location), or accept that the cache holds only ciphertext in E2E mode.
//
// Reads never throw on a damaged entry: it is a miss and the file is dropped; the engine opens every
// object again before use.

import { createHash } from "node:crypto";
import { readFile, readdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../core/jsonFile.js";
import { serialQueue } from "../core/serialQueue.js";
import {
  chunkCacheBudget,
  isChunkCacheId,
  SERVER_CHUNK_MAX_STORED_BYTES,
  type ChunkCache,
} from "@polaris-key/client-core/sync";

export const CLOUD_SYNC_CHUNKS_DIR = "cloud-sync-chunks";

const hash = (s: string): string =>
  createHash("sha256").update(s, "utf8").digest("hex");

/** `<stateDir>/cloud-sync-chunks/<hash(subject)>/<hash(collection)>`. */
export const chunkCacheDir = (
  stateDir: string,
  subject: string,
  collection: string,
): string =>
  join(stateDir, CLOUD_SYNC_CHUNKS_DIR, hash(subject), hash(collection));

interface Entry {
  size: number;
}

export class FileChunkCache implements ChunkCache {
  readonly #dir: string;
  readonly #max: number;
  /** id -> size, oldest first. Null until the directory has been scanned. */
  #index: Map<string, Entry> | null = null;
  #total = 0;
  readonly #serial = serialQueue();

  constructor(dir: string, maxBytes: number = chunkCacheBudget(0)) {
    this.#dir = dir;
    this.#max = maxBytes;
  }

  #check(id: string): void {
    if (!isChunkCacheId(id)) throw new RangeError("chunk cache id");
  }

  /** The directory's entries, oldest first (by modification time), scanned once. */
  async #load(): Promise<Map<string, Entry>> {
    if (this.#index !== null) return this.#index;
    const found: Array<{ id: string; size: number; at: number }> = [];
    let names: string[] = [];
    try {
      names = await readdir(this.#dir);
    } catch {
      // No directory yet.
    }
    for (const name of names) {
      const path = join(this.#dir, name);
      if (!isChunkCacheId(name)) {
        // A temporary file a crash left behind, or anything else we did not write.
        if (/\.tmp$/.test(name)) await rm(path, { force: true });
        continue;
      }
      try {
        const s = await stat(path);
        if (!s.isFile() || s.size > SERVER_CHUNK_MAX_STORED_BYTES) {
          await rm(path, { force: true });
          continue;
        }
        found.push({ id: name, size: s.size, at: s.mtimeMs });
      } catch {
        // Gone meanwhile.
      }
    }
    found.sort((a, b) => a.at - b.at);
    this.#index = new Map(found.map((f) => [f.id, { size: f.size }]));
    this.#total = found.reduce((n, f) => n + f.size, 0);
    return this.#index;
  }

  async get(id: string): Promise<Uint8Array | null> {
    this.#check(id);
    return this.#serial(async () => {
      const index = await this.#load();
      const held = index.get(id);
      if (held === undefined) return null;
      try {
        const bytes = await readFile(join(this.#dir, id));
        if (bytes.length !== held.size) throw new Error("size");
        // Newest goes last, here and on disk (so a relaunch keeps the order).
        index.delete(id);
        index.set(id, held);
        const now = new Date();
        await utimes(join(this.#dir, id), now, now).catch(() => undefined);
        return new Uint8Array(bytes);
      } catch {
        await this.#drop(id);
        return null;
      }
    });
  }

  async put(id: string, object: Uint8Array): Promise<void> {
    this.#check(id);
    return this.#serial(async () => {
      const index = await this.#load();
      await this.#drop(id);
      if (
        object.length > this.#max ||
        object.length > SERVER_CHUNK_MAX_STORED_BYTES
      )
        return;
      await writeFileAtomic(join(this.#dir, id), object);
      index.set(id, { size: object.length });
      this.#total += object.length;
      for (const [oldest, e] of index) {
        if (this.#total <= this.#max) break;
        if (oldest === id) continue;
        await rm(join(this.#dir, oldest), { force: true });
        index.delete(oldest);
        this.#total -= e.size;
      }
    });
  }

  async delete(id: string): Promise<void> {
    this.#check(id);
    return this.#serial(async () => {
      await this.#load();
      await this.#drop(id);
    });
  }

  clear(): Promise<void> {
    return this.#serial(async () => {
      await rm(this.#dir, { recursive: true, force: true });
      this.#index = new Map();
      this.#total = 0;
    });
  }

  async #drop(id: string): Promise<void> {
    const index = this.#index;
    const had = index?.get(id);
    if (had !== undefined) {
      index!.delete(id);
      this.#total -= had.size;
    }
    await rm(join(this.#dir, id), { force: true });
  }
}
