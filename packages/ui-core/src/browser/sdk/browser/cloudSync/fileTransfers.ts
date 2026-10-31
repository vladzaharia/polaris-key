// The browser's file layer for Cloud Sync (U-22.6; plans D-9, D-14): what a save's transfer needs
// from the page, assembled once. `SavesClient` binds the records on top of it (U-22.5's machine
// API); until then this is the file half, and the transcripts and tests drive it directly.
//
//   transport   `BrowserFileTransport` over the session's `fileFetch` (the bearer and the
//               `X-PKey-*` headers, no cookie, no redirect)
//   engine      client-core's `TransferEngine` over that transport and the IndexedDB journal; a
//               `Retry-After` is waited out up to 3600 s (the Worker may answer a write `503`)
//   cache       the chunk cache, bounded by `chunkCacheBudget`
//   exclusive   one writer: a transfer runs under the Web Lock `pkey-sync-files:<db>`, so two
//               tabs never drive the same journal; a tab that cannot take the lock waits its turn
//   purge       the journal, the chunk cache and the writer's identity go with the person
//
// Loaded on demand, never with the adapter: a page that moves no file pays nothing for it.

import {
  TransferEngine,
  chunkCacheBudget,
  type ChunkCache,
  type JournalStore,
} from "@polaris-key/client-core/sync";
import { BrowserFileTransport, type FileFetch } from "./files.js";
import { filesDbName } from "./filesPurge.js";
import { filesStore, type FilesStore } from "./idbJournal.js";
import type { HostLocks } from "./host.js";

/** The longest `Retry-After` a transfer waits out. */
export const FILES_MAX_RETRY_AFTER_SECONDS = 3600;
/** The default size of the largest file, which sizes the chunk cache (D-9). */
export const FILES_DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export interface BrowserFilesDeps {
  product: string;
  /** The settings record's database name; the files database is its neighbour. */
  dbName: string;
  fileFetch: FileFetch;
  locks: HostLocks;
  /** The collection's `files.maxBytes`; sizes the cache. Default 32 MiB. */
  maxBytes?: number;
  /** Test seams. */
  store?: FilesStore;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface BrowserFiles {
  readonly transport: BrowserFileTransport;
  readonly engine: TransferEngine;
  readonly journal: JournalStore;
  readonly cache: ChunkCache;
  readonly store: FilesStore;
  /** The Web Lock name of the one writer. */
  readonly lockName: string;
  /** Run `fn` as the one writer; it waits while another tab holds the lock. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** Delete the journal, the chunk cache and the writer's identity (with the person). */
  purge(): Promise<void>;
}

/** The file layer for one adapter. */
export function createBrowserFiles(d: BrowserFilesDeps): BrowserFiles {
  const store =
    d.store ??
    filesStore(
      filesDbName(d.dbName),
      chunkCacheBudget(d.maxBytes ?? FILES_DEFAULT_MAX_BYTES),
    );
  const transport = new BrowserFileTransport({
    product: d.product,
    request: d.fileFetch,
  });
  const engine = new TransferEngine({
    transport,
    journal: store.journal,
    maxRetryAfterSeconds: FILES_MAX_RETRY_AFTER_SECONDS,
    ...(d.sleep ? { sleep: d.sleep } : {}),
  });
  const lockName = `pkey-sync-files:${d.dbName}`;
  return {
    transport,
    engine,
    journal: store.journal,
    cache: store.cache,
    store,
    lockName,
    exclusive: <T>(fn: () => Promise<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        d.locks
          .request(lockName, async () => {
            try {
              resolve(await fn());
            } catch (e) {
              reject(e);
            }
          })
          .catch(reject);
      }),
    purge: () => store.purge(),
  };
}
