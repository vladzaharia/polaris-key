// The Cloud Connect state record, `pkey.connect.v1` (CC-09.1; WIRE-CONTRACT-V5 §15.3, §15.4), in the
// browser: the held roster and certificate as the compact JWSs the Worker signed, and K_disc, the
// discovery key(s), a secret of the same standing as the device keys. It lives in its own IndexedDB
// database beside the bearer store's (one per product and control-plane host), written as one JSON
// string so a structured clone never exposes K_disc as an object. Where IndexedDB does not exist,
// or the device keys are memory-only, the record is held in memory and dies with the page.
//
// Rules this module keeps:
//  - the record is parsed strictly; one that exists but is unusable is an error for the caller to
//    surface, never silently replaced (replacing it would forget the held roster);
//  - K_disc is a field of the record and of nothing else here: nothing logs, formats or returns it
//    except the client's `discoveryKeys()`, which hands out bytes.

export const CONNECT_STATE_SCHEMA = "pkey.connect.v1";

/** What is held for one device and one product. */
export interface ConnectStateRecord {
  schema: typeof CONNECT_STATE_SCHEMA;
  product: string;
  deviceId: string;
  /** The `pkey-ring+jws` held (verified when it was stored, and again when it is used). */
  ring: string;
  /** This device's `pkey-peer+jws`. */
  certificate: string;
  /** K_disc, newest first: the current key, then at most one previous key (canonical base64url). */
  discKeys: string[];
  /** The latest instant (seconds) the previous key may be used, or null when there is none. */
  prevUntil: number | null;
  /** The epoch of the roster the keys belong to. */
  epoch: number;
  /** The keys this device registered with the Worker, so an unchanged pair is not re-sent. */
  registered: { signKey: string; agreeKey: string } | null;
  storedAt: number;
  /** Set when a pushed roster removed a device: the Worker replaced K_disc then, so this copy is
   *  not used (adverts, relay) until an identity fetch brings the new one. */
  keysStale?: true;
}

/** Where the record lives. `get` answers the raw text, or null when nothing is held. */
export interface ConnectStateStore {
  readonly persistence: "durable" | "memory";
  get(): Promise<string | null>;
  put(text: string): Promise<void>;
  clear(): Promise<void>;
  /** Whether a record may exist, answered without creating storage. Absent means "unknown": ask
   *  `get()`. `leave()` uses it so an app that never used Connect gets no empty database. */
  mayHold?(): Promise<boolean>;
}

const KEY = /^[A-Za-z0-9_-]{43}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The record, or null when the text is not a usable `pkey.connect.v1` record. */
export function parseConnectState(raw: string): ConnectStateRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v) || v.schema !== CONNECT_STATE_SCHEMA) return null;
  const keys = v.discKeys;
  const reg = v.registered;
  if (
    typeof v.product !== "string" ||
    typeof v.deviceId !== "string" ||
    typeof v.ring !== "string" ||
    typeof v.certificate !== "string" ||
    !Array.isArray(keys) ||
    keys.length < 1 ||
    keys.length > 2 ||
    !keys.every((k) => typeof k === "string" && KEY.test(k)) ||
    !(v.prevUntil === null || Number.isSafeInteger(v.prevUntil)) ||
    !Number.isSafeInteger(v.epoch) ||
    !Number.isSafeInteger(v.storedAt)
  )
    return null;
  let registered: ConnectStateRecord["registered"] = null;
  if (reg !== null && reg !== undefined) {
    if (
      !isRecord(reg) ||
      typeof reg.signKey !== "string" ||
      typeof reg.agreeKey !== "string"
    )
      return null;
    registered = { signKey: reg.signKey, agreeKey: reg.agreeKey };
  }
  return {
    schema: CONNECT_STATE_SCHEMA,
    product: v.product,
    deviceId: v.deviceId,
    ring: v.ring,
    certificate: v.certificate,
    discKeys: keys as string[],
    prevUntil: v.prevUntil as number | null,
    epoch: v.epoch as number,
    registered,
    storedAt: v.storedAt as number,
    ...(v.keysStale === true ? { keysStale: true as const } : {}),
  };
}

/** A record held in memory only. */
export function memoryConnectState(): ConnectStateStore {
  let held: string | null = null;
  return {
    persistence: "memory",
    get: async () => held,
    put: async (text) => {
      held = text;
    },
    clear: async () => {
      held = null;
    },
  };
}

const STORE = "connect";
const KEY_NAME = "state";

/**
 * IndexedDB database `name`, or memory where there is no IndexedDB. A write is read back: an engine
 * that accepts it and keeps nothing is an error, not a record that looks stored and is gone after a
 * reload.
 */
export function indexedDbConnectState(
  name: string,
  idb: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory })
    .indexedDB,
): ConnectStateStore {
  if (idb === undefined) return memoryConnectState();
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    const p = (db ??= new Promise<IDBDatabase>((res, rej) => {
      const r = idb.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => {
        const d = r.result;
        d.onclose = () => {
          if (db === p) db = null;
        };
        d.onversionchange = () => {
          d.close();
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
  const run = async <T>(
    mode: IDBTransactionMode,
    f: (s: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const d = await open();
    const tx = d.transaction(STORE, mode);
    const req = f(tx.objectStore(STORE));
    return new Promise<T>((res, rej) => {
      tx.oncomplete = () => res(req.result);
      tx.onerror = () => rej(tx.error ?? new Error("indexeddb"));
      tx.onabort = () => rej(tx.error ?? new Error("indexeddb"));
    });
  };
  const markerKey = `pkey-connect-used:${name}`;
  const ls = (): Storage | null => {
    try {
      return (globalThis as { localStorage?: Storage }).localStorage ?? null;
    } catch {
      return null;
    }
  };
  const mark = (on: boolean): void => {
    try {
      if (on) ls()?.setItem(markerKey, "1");
      else ls()?.removeItem(markerKey);
    } catch {
      // A marker is a hint; the database stays the truth.
    }
  };
  return {
    persistence: "durable",
    async mayHold() {
      // Never open the database just to look: an open creates it.
      if (typeof idb.databases === "function") {
        try {
          return (await idb.databases()).some((d) => d.name === name);
        } catch {
          // Fall through to the marker.
        }
      }
      const store = ls();
      if (store === null) return true;
      try {
        return store.getItem(markerKey) !== null;
      } catch {
        return true;
      }
    },
    async get() {
      const v = await run("readonly", (s) => s.get(KEY_NAME));
      if (v === undefined || v === null) return null;
      // Anything that is not text is not ours; hand it on as unusable text.
      return typeof v === "string" ? v : "\0";
    },
    async put(text) {
      await run("readwrite", (s) => s.put(text, KEY_NAME));
      if ((await run("readonly", (s) => s.get(KEY_NAME))) !== text)
        throw new Error("indexeddb dropped the record");
      mark(true);
    },
    async clear() {
      await run("readwrite", (s) => s.delete(KEY_NAME));
      mark(false);
    },
  };
}
