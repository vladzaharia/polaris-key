// The browser device key store (CC-26.1; plans/CC-01.md R-5, plan-cloud-connect.md D7): Ed25519
// and X25519 keys held by WebCrypto as non-extractable `CryptoKey`s and persisted in IndexedDB,
// which stores the key objects themselves (structured clone), never their bytes. The private
// halves therefore cannot be read back by this module or by script on the page: `sign` and `dh`
// are the only ways to use them.
//
// Fallbacks, all tested:
//  - No WebCrypto Ed25519 or X25519 (Chromium before 137, Firefox before 129, Safari before 17):
//    `DeviceKeyUnsupportedError`. There is no software fallback, because a key the page can read
//    would defeat the custody this store exists for. The host reports "unsupported" and does not
//    take part in automatic sign-in or Cloud Connect on that browser.
//  - No usable IndexedDB (a private window, a blocked store, an engine that cannot clone a
//    `CryptoKey`, or one that accepts the write and keeps nothing, as WebKit does for X25519
//    keys): the keys live in memory for the page's life, `persistence` says "memory", and
//    a reload makes a new pair (a new registration, at the server's 4 changes a day).
//  - An engine that makes the private key extractable anyway: refused, never used.

import { base64UrlEncodeBytes, isX25519LowOrder } from "@polaris-key/jws";
import {
  DeviceKeyUnsupportedError,
  type DeviceKeyPort,
  type DevicePublicKeys,
} from "./deviceKeys.js";

/** What the store keeps: key objects, not bytes. */
export interface StoredDeviceKeys {
  v: 1;
  generation: number;
  sign: CryptoKeyPair;
  agree: CryptoKeyPair;
}

/** Where `StoredDeviceKeys` live. Atomic where the backend can be (`putIfAbsent`). */
export interface DeviceKeyStorage {
  get(): Promise<StoredDeviceKeys | null>;
  /** Stores `rec` unless a record exists; returns the record now stored. */
  putIfAbsent(rec: StoredDeviceKeys): Promise<StoredDeviceKeys>;
  put(rec: StoredDeviceKeys): Promise<void>;
  clear(): Promise<void>;
}

export function memoryDeviceKeyStorage(): DeviceKeyStorage {
  let cur: StoredDeviceKeys | null = null;
  return {
    get: async () => cur,
    putIfAbsent: async (rec) => (cur ??= rec),
    put: async (rec) => {
      cur = rec;
    },
    clear: async () => {
      cur = null;
    },
  };
}

const STORE = "keys";
const RECORD_KEY = "device";

function reqDone<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error ?? new Error("indexeddb"));
  });
}
function txDone(t: IDBTransaction): Promise<void> {
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error ?? new Error("indexeddb"));
    t.onabort = () => rej(t.error ?? new Error("indexeddb"));
  });
}

/** IndexedDB storage in database `name`. Throws on open if IndexedDB is not usable. */
export function indexedDbDeviceKeyStorage(
  name = "pkey-device-keys",
  idb: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory })
    .indexedDB,
): DeviceKeyStorage {
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (!idb) return Promise.reject(new Error("indexeddb unavailable"));
    const p = (db ??= new Promise<IDBDatabase>((res, rej) => {
      const r = idb.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => {
        const d = r.result;
        // The browser closed the connection, or another tab upgrades the database: reopen.
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
  // An engine may accept a write of a CryptoKey and keep nothing (WebKit does so for X25519 keys,
  // Playwright WebKit 2359): read every write back, or the keys would look stored and be gone
  // after a reload.
  const kept = async (): Promise<boolean> => {
    const d = await open();
    const v = await reqDone(
      d.transaction(STORE, "readonly").objectStore(STORE).get(RECORD_KEY),
    );
    return v !== undefined && v !== null;
  };
  return {
    async get() {
      const d = await open();
      const v = await reqDone(
        d.transaction(STORE, "readonly").objectStore(STORE).get(RECORD_KEY),
      );
      return (v as StoredDeviceKeys | undefined) ?? null;
    },
    async putIfAbsent(rec) {
      const d = await open();
      const t = d.transaction(STORE, "readwrite");
      const s = t.objectStore(STORE);
      const existing = await reqDone(s.get(RECORD_KEY));
      if (existing) return existing as StoredDeviceKeys;
      s.put(rec, RECORD_KEY);
      await txDone(t);
      if (!(await kept())) throw new Error("indexeddb dropped the keys");
      return rec;
    },
    async put(rec) {
      const d = await open();
      const t = d.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(rec, RECORD_KEY);
      await txDone(t);
      if (!(await kept())) throw new Error("indexeddb dropped the keys");
    },
    async clear() {
      if (!idb) return; // no IndexedDB here, so nothing stored there
      const d = await open();
      const t = d.transaction(STORE, "readwrite");
      t.objectStore(STORE).delete(RECORD_KEY);
      await txDone(t);
    },
  };
}

export interface WebDeviceKeyPort extends DeviceKeyPort {
  /** "durable" when the keys are in IndexedDB, "memory" when they die with the page. */
  persistence(): Promise<"durable" | "memory">;
}

export interface WebDeviceKeyOptions {
  /** Default IndexedDB `pkey-device-keys`, falling back to memory. */
  storage?: DeviceKeyStorage;
  /**
   * With an explicit `storage`, still fall back to memory if its first open or write fails
   * before any durable record was read (the default storage always does). Never after.
   */
  fallbackToMemory?: boolean;
  /** The WebCrypto to use; default `globalThis.crypto.subtle`. */
  subtle?: SubtleCrypto;
}

const isCryptoKey = (k: unknown): k is CryptoKey =>
  !!k && typeof k === "object" && "algorithm" in k && "extractable" in k;

function keyOk(
  k: unknown,
  type: "private" | "public",
  alg: string,
  usage: KeyUsage,
): boolean {
  if (!isCryptoKey(k)) return false;
  return (
    k.type === type &&
    k.algorithm?.name === alg &&
    Array.isArray(k.usages) &&
    k.usages.includes(usage)
  );
}

function validShape(rec: StoredDeviceKeys | null): rec is StoredDeviceKeys {
  return (
    !!rec &&
    rec.v === 1 &&
    Number.isSafeInteger(rec.generation) &&
    rec.generation >= 1 &&
    keyOk(rec.sign?.privateKey, "private", "Ed25519", "sign") &&
    keyOk(rec.sign?.publicKey, "public", "Ed25519", "verify") &&
    keyOk(rec.agree?.privateKey, "private", "X25519", "deriveBits") &&
    rec.agree?.publicKey?.type === "public" &&
    rec.agree.publicKey.algorithm?.name === "X25519" &&
    !rec.sign.privateKey.extractable &&
    !rec.agree.privateKey.extractable
  );
}

/** The browser's `DeviceKeyPort` on WebCrypto. */
export function createWebDeviceKeyStore(
  o: WebDeviceKeyOptions = {},
): WebDeviceKeyPort {
  const subtle = o.subtle ?? globalThis.crypto?.subtle;
  // The durable store, kept by its own reference so `wipe` always reaches it. Only the default
  // may fall back to memory; an explicit storage is the host's.
  const durableStorage: DeviceKeyStorage =
    o.storage ?? indexedDbDeviceKeyStorage();
  const mayFallBack = !o.storage || o.fallbackToMemory === true;
  let memory: DeviceKeyStorage | null = null;
  // True once the durable store has returned a usable record or kept a write. From then on its
  // errors are rethrown: swapping to a fresh memory identity would hide the device's real one.
  let durableSeen = false;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const r = chain.then(f, f);
    chain = r.catch(() => undefined);
    return r;
  };
  // Across tabs: one creator, rotator or wiper at a time where the Locks API exists.
  const locked = <T>(f: () => Promise<T>): Promise<T> => {
    const locks = (
      globalThis as {
        navigator?: {
          locks?: {
            request<R>(name: string, cb: () => Promise<R>): Promise<R>;
          };
        };
      }
    ).navigator?.locks;
    return locks ? locks.request("pkey-device-keys", f) : f();
  };
  const needSubtle = (): SubtleCrypto => {
    if (!subtle)
      throw new DeviceKeyUnsupportedError("device keys: no WebCrypto");
    return subtle;
  };

  async function run<T>(
    f: (s: DeviceKeyStorage) => Promise<T>,
    kept: (r: T) => boolean = () => true,
  ): Promise<T> {
    if (memory) return f(memory);
    try {
      const r = await f(durableStorage);
      if (kept(r)) durableSeen = true;
      return r;
    } catch (e) {
      if (!mayFallBack || durableSeen || e instanceof DeviceKeyUnsupportedError)
        throw e;
      memory = memoryDeviceKeyStorage();
      return f(memory);
    }
  }

  async function generate(generation: number): Promise<StoredDeviceKeys> {
    const subtle = needSubtle();
    let sign: CryptoKeyPair, agree: CryptoKeyPair;
    try {
      sign = (await subtle.generateKey({ name: "Ed25519" }, false, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      agree = (await subtle.generateKey({ name: "X25519" }, false, [
        "deriveBits",
      ])) as CryptoKeyPair;
    } catch {
      throw new DeviceKeyUnsupportedError(
        "device keys: this browser has no WebCrypto Ed25519 or X25519",
      );
    }
    if (sign.privateKey.extractable || agree.privateKey.extractable)
      throw new DeviceKeyUnsupportedError(
        "device keys: this browser makes extractable private keys",
      );
    return { v: 1, generation, sign, agree };
  }

  async function publicOf(r: StoredDeviceKeys): Promise<DevicePublicKeys> {
    const subtle = needSubtle();
    const s = new Uint8Array(await subtle.exportKey("raw", r.sign.publicKey));
    const a = new Uint8Array(await subtle.exportKey("raw", r.agree.publicKey));
    return {
      signKey: base64UrlEncodeBytes(s),
      agreeKey: base64UrlEncodeBytes(a),
      generation: r.generation,
    };
  }

  const load = async (): Promise<StoredDeviceKeys | null> => {
    const rec = await run(
      (s) => s.get(),
      (r) => validShape(r),
    );
    return validShape(rec) ? rec : null;
  };

  const port: WebDeviceKeyPort = {
    ensure: () =>
      serial(async () => {
        const cur = await load();
        if (cur) return publicOf(cur);
        return locked(async () => {
          const again = await load(); // another tab may have made the pair
          if (again) return publicOf(again);
          const made = await generate(1);
          const won = await run(
            (s) => s.putIfAbsent(made),
            (r) => validShape(r),
          );
          if (validShape(won)) return publicOf(won);
          await run((s) => s.put(made)); // a record this code cannot use is replaced
          return publicOf(made);
        });
      }),
    publicKeys: () =>
      serial(async () => {
        const cur = await load();
        return cur ? publicOf(cur) : null;
      }),
    sign: (message) =>
      serial(async () => {
        const cur = await load();
        if (!cur) throw new Error("device keys: none; call ensure() first");
        return new Uint8Array(
          await needSubtle().sign(
            { name: "Ed25519" },
            cur.sign.privateKey,
            message as BufferSource,
          ),
        );
      }),
    dh: (peerPublic) =>
      serial(async () => {
        if (peerPublic.length !== 32 || isX25519LowOrder(peerPublic))
          return null;
        const cur = await load();
        if (!cur) return null;
        try {
          const subtle = needSubtle();
          const peer = await subtle.importKey(
            "raw",
            peerPublic as BufferSource,
            { name: "X25519" },
            false,
            [],
          );
          const bits = new Uint8Array(
            await subtle.deriveBits(
              { name: "X25519", public: peer },
              cur.agree.privateKey,
              256,
            ),
          );
          return bits.some((b) => b !== 0) ? bits : null;
        } catch {
          return null;
        }
      }),
    rotate: () =>
      serial(async () => {
        return locked(async () => {
          const cur = await load(); // read under the lock: the generation is compare-and-set
          const next = await generate((cur?.generation ?? 0) + 1);
          // A failed durable write rethrows once a durable record was seen, so a rotate never
          // answers with a memory key while the durable record keeps the old one.
          await run((s) => s.put(next));
          return publicOf(next);
        });
      }),
    wipe: () =>
      serial(() =>
        locked(async () => {
          // Both stores, never a fallback: an IndexedDB error is the caller's to see.
          if (memory) await memory.clear();
          await durableStorage.clear();
        }),
      ),
    persistence: async () => (memory ? "memory" : "durable"),
  };
  return port;
}
