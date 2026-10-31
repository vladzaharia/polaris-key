// The chunk cache port (U-22.2, plan D-9). It holds chunk objects as stored (ciphertext in E2E
// mode, never plaintext), keyed by the 64-character hex chunk id, so a download fetches only the
// chunks the device lacks. Hosts name entries from the id alone, never from server text: `get`,
// `put` and `delete` take an id that already matches `SYNC_CHUNK_ID_PATTERN` (`isChunkCacheId`).
//
// A cache is best effort: the engine treats a failing `get` as a miss and a failing `put` as
// nothing, and it opens every cached object again before use, so a damaged entry costs a fetch.
// The host bounds it with an LRU of `chunkCacheBudget(largestSave)` bytes per (product, subject,
// collection), keeps it out of OS backup, and purges it with the person (sign-out, `forget`).

export interface ChunkCache {
  get(id: string): Promise<Uint8Array | null>;
  put(id: string, object: Uint8Array): Promise<void>;
  delete(id: string): Promise<void>;
  /** Drop every entry: the purge that goes with the person. */
  clear(): Promise<void>;
}

/** The least a cache is allowed to hold (D-9). */
export const CHUNK_CACHE_MIN_BYTES = 256 * 1024 * 1024;

/** D-9: at most `max(256 MiB, twice the largest save)`. */
export function chunkCacheBudget(largestSaveBytes: number): number {
  if (!Number.isSafeInteger(largestSaveBytes) || largestSaveBytes < 0)
    throw new RangeError("largest save");
  return Math.max(CHUNK_CACHE_MIN_BYTES, 2 * largestSaveBytes);
}

const ID = /^[0-9a-f]{64}$/;

/** True for a chunk id that is safe to turn into a file or key name. */
export const isChunkCacheId = (id: string): boolean => ID.test(id);

/** An in-memory LRU: tests, and a host with no durable store (the cache then lasts one session). */
export function memoryChunkCache(
  maxBytes: number = CHUNK_CACHE_MIN_BYTES,
): ChunkCache {
  const map = new Map<string, Uint8Array>();
  let total = 0;
  const check = (id: string): void => {
    if (!ID.test(id)) throw new RangeError("chunk cache id");
  };
  return {
    async get(id) {
      check(id);
      const hit = map.get(id);
      if (hit === undefined) return null;
      // Most recently used goes last.
      map.delete(id);
      map.set(id, hit);
      return Uint8Array.from(hit);
    },
    async put(id, object) {
      check(id);
      const had = map.get(id);
      if (had !== undefined) {
        total -= had.length;
        map.delete(id);
      }
      if (object.length > maxBytes) return;
      map.set(id, Uint8Array.from(object));
      total += object.length;
      for (const [k, v] of map) {
        if (total <= maxBytes) break;
        map.delete(k);
        total -= v.length;
      }
    },
    async delete(id) {
      check(id);
      const had = map.get(id);
      if (had !== undefined) {
        total -= had.length;
        map.delete(id);
      }
    },
    async clear() {
      map.clear();
      total = 0;
    },
  };
}
