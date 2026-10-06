// The browser's `core.store` (SDK-PARITY-PASS §3.17): client-core's `Store` contract over
// IndexedDB, for bearer mode.
//
//   token      the `pkeyt_` device token, in its own object store (`tokens`), so a bundle import
//              (which REPLACES the offline record, §7 step 5) never drops it — as in Node
//   deviceId   the random id the offline record already holds (`../offline.ts`), so a page that
//              imported a bundle and later activates online is ONE device, not two
//   cache      the record's `CacheRecordV3`: signed artifacts only, re-verified on every load
//
// THE TRADE-OFF (owner question Q1). An IndexedDB token is readable by any script running on
// the page, which an HttpOnly cookie is not. `status()` reports that honestly: backend
// `indexeddb`, degraded `not-persistent` unless the page holds persistent storage
// (`navigator.storage.persisted()`), because a browser may evict the database under pressure.

import type {
  CacheRecordV3,
  Store,
  StoreStatus,
} from "@polaris-key/client-core";
import {
  TOKEN_STORE_NAME,
  ensureRecord,
  indexedDbOfflineStore,
  openPolarisDb,
  request,
  type OfflineStore,
} from "../offline.js";

/** client-core's `Store`, plus the offline record's store it shares the device id with. */
export interface BrowserStore extends Store {
  /** The offline record store behind `getDeviceId`/`readCache`. */
  readonly offline: OfflineStore;
  status(): Promise<StoreStatus>;
}

/** What `status()` reads about the page's storage; the page's globals by default. */
export interface StoragePersistence {
  persisted?: () => Promise<boolean>;
}

function pagePersistence(): StoragePersistence | undefined {
  const nav = (globalThis as { navigator?: { storage?: StoragePersistence } })
    .navigator;
  return nav?.storage;
}

/**
 * The IndexedDB `Store` for one product, or `null` where IndexedDB does not exist (a server
 * render, a locked-down webview). The browser adapter then falls back to `memoryStore`, whose
 * `status()` reports backend `memory`, degraded `not-persistent`, so the page is told the
 * credential does not outlive it rather than led to think it persists.
 */
export function indexedDbStore(
  product: string,
  opts: {
    factory?: IDBFactory;
    persistence?: StoragePersistence;
  } = {},
): BrowserStore | null {
  const factory =
    opts.factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
  if (!factory) return null;
  const offline = indexedDbOfflineStore(factory);
  if (!offline) return null;
  const tokens = async (mode: IDBTransactionMode) =>
    (await openPolarisDb(factory))
      .transaction(TOKEN_STORE_NAME, mode)
      .objectStore(TOKEN_STORE_NAME);
  return recordStore(product, offline, {
    async get() {
      const v: unknown = await request((await tokens("readonly")).get(product));
      return typeof v === "string" && v !== "" ? v : null;
    },
    async set(token) {
      await request((await tokens("readwrite")).put(token, product));
    },
    async clear() {
      await request((await tokens("readwrite")).delete(product));
    },
    async status() {
      const persistence = opts.persistence ?? pagePersistence();
      let persisted = false;
      try {
        persisted = (await persistence?.persisted?.()) === true;
      } catch {
        persisted = false;
      }
      return persisted
        ? { backend: "indexeddb" }
        : {
            backend: "indexeddb",
            degraded: {
              reason: "not-persistent",
              detail:
                "The browser may evict this site's storage; call navigator.storage.persist() to keep the sign-in.",
            },
          };
    },
  });
}

/** A `Store` that keeps nothing past the page (tests, previews, a browser without IndexedDB). */
export function memoryStore(
  product: string,
  offline?: OfflineStore,
): BrowserStore {
  const records = new Map<string, Awaited<ReturnType<OfflineStore["read"]>>>();
  const backing: OfflineStore = offline ?? {
    async read(p) {
      return records.get(p) ?? null;
    },
    async write(p, r) {
      records.set(p, r);
    },
  };
  let token: string | null = null;
  return recordStore(product, backing, {
    async get() {
      return token;
    },
    async set(t) {
      token = t;
    },
    async clear() {
      token = null;
    },
    async status() {
      return {
        backend: "memory",
        degraded: {
          reason: "not-persistent",
          detail: "Kept for this page only.",
        },
      };
    },
  });
}

interface TokenSlot {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
  status(): Promise<StoreStatus>;
}

function recordStore(
  product: string,
  offline: OfflineStore,
  token: TokenSlot,
): BrowserStore {
  return {
    offline,
    getToken: () => token.get(),
    setToken: (t) => token.set(t),
    clearToken: () => token.clear(),
    async getDeviceId() {
      return (await ensureRecord(offline, product)).deviceId;
    },
    async readCache() {
      return (await offline.read(product))?.cache ?? null;
    },
    async writeCache(rec: CacheRecordV3) {
      const record = await ensureRecord(offline, product);
      await offline.write(product, { ...record, cache: rec });
    },
    async clearCache() {
      const record = await ensureRecord(offline, product);
      await offline.write(product, { deviceId: record.deviceId });
    },
    status: () => token.status(),
  };
}
