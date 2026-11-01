// The browser's durable state for Cloud Sync files (U-22.6; plan D-9): the transfer journal, the
// chunk cache and a small record of the saves writer's own identity, in one IndexedDB database,
// `pkey-sync-<product>-files`, beside the settings record's `pkey-sync-<product>`.
//
//   journal   `JournalStore`: one record per upload (client-core `TransferJournalRecord`, plain
//             JSON), so an upload carries on after a reload. Only the writer tab writes.
//   chunks    `ChunkCache`: chunk objects AS STORED (ciphertext in end-to-end mode), keyed by the
//             64-hex chunk id, an LRU bounded by `chunkCacheBudget`. A damaged or missing entry
//             costs a fetch, never a wrong byte: the engine opens every cached object again.
//   meta      the saves client id and the next mutation id (not secrets).
//
// Nothing here is plaintext of a save. The database is deleted with the person (`purgeFilesStore`):
// sign-out, deactivation and `account_required` go through the host's purge.
//
// Where the page has no IndexedDB the store is memory: a transfer then does not survive a reload
// and the cache lasts one page.

import {
  CHUNK_CACHE_MIN_BYTES,
  isChunkCacheId,
  memoryChunkCache,
  memoryJournal,
  type ChunkCache,
  type JournalStore,
  type TransferJournalRecord,
} from "@polaris-key/client-core/sync";

import { deleteDb } from "./filesPurge.js";

const JOURNAL = "journal";
const CHUNKS = "chunks";
const META = "meta";

/** One cached chunk: its stored bytes and when it was last used (ms). */
interface ChunkRow {
  b: Uint8Array;
  t: number;
}

/** Small durable values the saves layer keeps for itself. */
export interface MetaStore {
  get(key: string): Promise<unknown | null>;
  put(key: string, value: unknown): Promise<void>;
}

export interface FilesStore {
  readonly journal: JournalStore;
  /** The chunk cache of no person (the unscoped namespace). */
  readonly cache: ChunkCache;
  /** The chunk cache of one person: a purge of another person leaves it be. */
  scoped(scope: string): ChunkCache;
  readonly meta: MetaStore;
  readonly persistence: "durable" | "memory";
  /** Close the connection (the database stays). */
  close(): void;
  /** Delete what is held (the connection is closed first). With a scope, only that person's chunks
   *  go (and the journal and meta, which no person owns); the database itself goes once no other
   *  person's chunks are left. Without one, everything goes. */
  purge(scope?: string): Promise<void>;
}

/** A chunk row's key: the person's scope, a separator no chunk id holds, the chunk id. */
const SEP = "\u0000";
const keyOf = (scope: string, id: string): string => `${scope}${SEP}${id}`;
const prefixOf = (scope: string): string => `${scope}${SEP}`;

const factoryOf = (idb?: IDBFactory): IDBFactory | undefined =>
  idb ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? undefined;

function memoryStore(budget: number): FilesStore {
  const meta = new Map<string, unknown>();
  const caches = new Map<string, ChunkCache>();
  const scoped = (scope: string): ChunkCache => {
    let c = caches.get(scope);
    if (!c) caches.set(scope, (c = memoryChunkCache(budget)));
    return c;
  };
  let journal = memoryJournal();
  return {
    persistence: "memory",
    get journal() {
      return journal;
    },
    get cache() {
      return scoped("");
    },
    scoped,
    meta: {
      get: async (k) => meta.get(k) ?? null,
      put: async (k, v) => {
        meta.set(k, v);
      },
    },
    close() {},
    async purge(scope) {
      meta.clear();
      if (scope === undefined) caches.clear();
      else caches.delete(scope);
      journal = memoryJournal();
    },
  };
}

/**
 * The files store for database `name`, bounded to `budgetBytes` of cached chunks. IndexedDB when
 * the page has it, memory when not.
 */
export function filesStore(
  name: string,
  budgetBytes: number = CHUNK_CACHE_MIN_BYTES,
  idb?: IDBFactory | undefined,
): FilesStore {
  const factory = factoryOf(idb);
  if (factory === undefined) return memoryStore(budgetBytes);
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    const p = (db ??= new Promise<IDBDatabase>((res, rej) => {
      const r = factory.open(name, 1);
      r.onupgradeneeded = () => {
        for (const s of [JOURNAL, CHUNKS, META])
          if (!r.result.objectStoreNames.contains(s))
            r.result.createObjectStore(s);
      };
      r.onsuccess = () => {
        const d = r.result;
        // Another tab deleting or upgrading the database (a purge) is let through.
        d.onversionchange = () => {
          d.close();
          if (db === p) db = null;
        };
        d.onclose = () => {
          if (db === p) db = null;
        };
        res(d);
      };
      r.onerror = () => rej(r.error ?? new Error("indexeddb"));
      r.onblocked = () => rej(new Error("indexeddb blocked"));
    }));
    p.catch(() => {
      if (db === p) db = null;
    });
    return p;
  };
  const tx = async <T>(
    store: string,
    mode: IDBTransactionMode,
    f: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const d = await open();
    const t = d.transaction(store, mode);
    const req = f(t.objectStore(store));
    return new Promise<T>((res, rej) => {
      t.oncomplete = () => res(req.result);
      t.onerror = () => rej(t.error ?? new Error("indexeddb"));
      t.onabort = () => rej(t.error ?? new Error("indexeddb"));
    });
  };

  const journal: JournalStore = {
    async get(id) {
      const v = await tx<unknown>(JOURNAL, "readonly", (s) => s.get(id));
      return v === undefined ? null : v;
    },
    async put(id, record: TransferJournalRecord) {
      await tx(JOURNAL, "readwrite", (s) => s.put(record, id));
    },
    async delete(id) {
      await tx(JOURNAL, "readwrite", (s) => s.delete(id));
    },
    async list() {
      const keys = await tx<IDBValidKey[]>(JOURNAL, "readonly", (s) =>
        s.getAllKeys(),
      );
      return keys.filter((k): k is string => typeof k === "string");
    },
  };

  const check = (id: string): void => {
    if (!isChunkCacheId(id)) throw new RangeError("chunk cache id");
  };
  /** The sum of the cached sizes, or null until it has been read. */
  let total: number | null = null;
  const sizeOf = (row: unknown): number =>
    row !== null && typeof row === "object" && "b" in row
      ? ((row as ChunkRow).b?.byteLength ?? 0)
      : 0;
  const readTotal = async (): Promise<number> => {
    if (total !== null) return total;
    const rows = await tx<unknown[]>(CHUNKS, "readonly", (s) => s.getAll());
    return (total = rows.reduce<number>((n, r) => n + sizeOf(r), 0));
  };
  /** Delete every chunk row of one person, in one transaction. */
  const dropScope = async (scope: string): Promise<void> => {
    const d = await open();
    const prefix = prefixOf(scope);
    await new Promise<void>((res, rej) => {
      const t = d.transaction(CHUNKS, "readwrite");
      const st = t.objectStore(CHUNKS);
      const req = st.getAllKeys();
      req.onsuccess = () => {
        for (const k of req.result)
          if (typeof k === "string" && k.startsWith(prefix)) st.delete(k);
      };
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error ?? new Error("indexeddb"));
      t.onabort = () => rej(t.error ?? new Error("indexeddb"));
    });
  };
  const cacheOf = (scope: string): ChunkCache => ({
    async get(id) {
      check(id);
      const key = keyOf(scope, id);
      const row = await tx<ChunkRow | undefined>(CHUNKS, "readonly", (s) =>
        s.get(key),
      );
      if (!row || !(row.b instanceof Uint8Array)) return null;
      // Most recently used goes last: touch the stamp, best effort.
      void tx(CHUNKS, "readwrite", (s) =>
        s.put({ b: row.b, t: Date.now() }, key),
      ).catch(() => undefined);
      return Uint8Array.from(row.b);
    },
    async put(id, object) {
      check(id);
      const key = keyOf(scope, id);
      if (object.byteLength > budgetBytes) return;
      let used = await readTotal();
      const had = await tx<ChunkRow | undefined>(CHUNKS, "readonly", (s) =>
        s.get(key),
      );
      used -= sizeOf(had);
      await tx(CHUNKS, "readwrite", (s) =>
        s.put({ b: Uint8Array.from(object), t: Date.now() } as ChunkRow, key),
      );
      used += object.byteLength;
      total = used;
      if (used <= budgetBytes) return;
      // Over budget: drop the least recently used until it fits.
      const d = await open();
      const rows = await new Promise<
        Array<{ id: string; n: number; t: number }>
      >((res, rej) => {
        const out: Array<{ id: string; n: number; t: number }> = [];
        const c = d.transaction(CHUNKS, "readonly").objectStore(CHUNKS);
        const cur = c.openCursor();
        cur.onsuccess = () => {
          const k = cur.result;
          if (!k) return res(out);
          const row = k.value as ChunkRow;
          out.push({
            id: String(k.key),
            n: sizeOf(row),
            t: typeof row.t === "number" ? row.t : 0,
          });
          k.continue();
        };
        cur.onerror = () => rej(cur.error ?? new Error("indexeddb"));
      });
      rows.sort((a, b) => a.t - b.t);
      for (const r of rows) {
        if (used <= budgetBytes) break;
        if (r.id === key) continue;
        await tx(CHUNKS, "readwrite", (s) => s.delete(r.id));
        used -= r.n;
      }
      total = used;
    },
    async delete(id) {
      check(id);
      const key = keyOf(scope, id);
      const had = await tx<ChunkRow | undefined>(CHUNKS, "readonly", (s) =>
        s.get(key),
      );
      await tx(CHUNKS, "readwrite", (s) => s.delete(key));
      if (total !== null) total = Math.max(0, total - sizeOf(had));
    },
    async clear() {
      await dropScope(scope);
      total = null;
    },
  });

  const meta: MetaStore = {
    async get(key) {
      const v = await tx<unknown>(META, "readonly", (s) => s.get(key));
      return v === undefined ? null : v;
    },
    async put(key, value) {
      await tx(META, "readwrite", (s) => s.put(value, key));
    },
  };

  const close = (): void => {
    const p = db;
    db = null;
    void p?.then((d) => d.close()).catch(() => undefined);
  };
  return {
    persistence: "durable",
    journal,
    cache: cacheOf(""),
    scoped: cacheOf,
    meta,
    close,
    purge: async (scope) => {
      if (scope !== undefined) {
        // Only the leaving person's chunks go; the journal and meta belong to no person.
        try {
          await dropScope(scope);
          await tx(JOURNAL, "readwrite", (s) => s.clear());
          await tx(META, "readwrite", (s) => s.clear());
          const left = await tx<number>(CHUNKS, "readonly", (s) => s.count());
          total = null;
          if (left > 0) return;
        } catch {
          // Fall through to the whole database: a purge never leaves the person's data behind.
        }
      }
      close();
      total = null;
      await deleteDb(factory, name);
    },
  };
}
