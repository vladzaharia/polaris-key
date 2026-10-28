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

/** How the stored device token was obtained. Only `signin` is a signed-in account; `register` is
 *  an anonymous device and `key` a licence-key activation. */
export type TokenProvenance = "signin" | "register" | "key";

/** client-core's `Store`, plus the offline record's store it shares the device id with. */
export interface BrowserStore extends Store {
  /** The offline record store behind `getDeviceId`/`readCache`. */
  readonly offline: OfflineStore;
  status(): Promise<StoreStatus>;
  /**
   * The explicit-sign-out flag (web automatic sign-in): set by `signOut()`, cleared by the next
   * explicit sign-in. While it is set the ladder does not try the platform provider. It lives
   * beside the token, so it survives a reload, and a bundle import does not drop it.
   */
  /**
   * Where the token came from, kept beside it (cleared with it). A token with none (stored before
   * this existed) is not counted as a sign-in.
   */
  readonly provenance?: {
    get(): Promise<TokenProvenance | null>;
    set(p: TokenProvenance | null): Promise<void>;
  };
  readonly explicitSignOut?: {
    get(): Promise<boolean>;
    set(on: boolean): Promise<void>;
  };
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
    /** Empty for production; a non-default host's IndexedDB suffix otherwise. */
    namespace?: string;
  } = {},
): BrowserStore | null {
  const factory =
    opts.factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
  if (!factory) return null;
  const offline = indexedDbOfflineStore(factory, opts.namespace);
  if (!offline) return null;
  const tokens = async (mode: IDBTransactionMode) =>
    (await openPolarisDb(factory, opts.namespace))
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
      const store = await tokens("readwrite");
      await request(store.delete(product));
      await request(store.delete(provenanceKey(product)));
    },
    async getMeta() {
      const v: unknown = await request(
        (await tokens("readonly")).get(provenanceKey(product)),
      );
      return v === "signin" || v === "register" || v === "key" ? v : null;
    },
    async setMeta(p) {
      const store = await tokens("readwrite");
      if (p) await request(store.put(p, provenanceKey(product)));
      else await request(store.delete(provenanceKey(product)));
    },
    async getFlag() {
      return (
        (await request((await tokens("readonly")).get(flagKey(product)))) === 1
      );
    },
    async setFlag(on) {
      const store = await tokens("readwrite");
      if (on) await request(store.put(1, flagKey(product)));
      else await request(store.delete(flagKey(product)));
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
  let flag = false;
  let meta: TokenProvenance | null = null;
  return recordStore(product, backing, {
    async get() {
      return token;
    },
    async set(t) {
      token = t;
    },
    async clear() {
      token = null;
      meta = null;
    },
    async getMeta() {
      return meta;
    },
    async setMeta(p) {
      meta = p;
    },
    async getFlag() {
      return flag;
    },
    async setFlag(on) {
      flag = on;
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
  getMeta(): Promise<TokenProvenance | null>;
  setMeta(p: TokenProvenance | null): Promise<void>;
  getFlag(): Promise<boolean>;
  setFlag(on: boolean): Promise<void>;
  status(): Promise<StoreStatus>;
}

const provenanceKey = (product: string): string => `${product}\0provenance`;

/** The flag's key in the `tokens` object store; a product id never contains a NUL. */
const flagKey = (product: string): string => `${product}\0explicitSignOut`;

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
    provenance: { get: () => token.getMeta(), set: (p) => token.setMeta(p) },
    explicitSignOut: {
      get: () => token.getFlag(),
      set: (on) => token.setFlag(on),
    },
  };
}
