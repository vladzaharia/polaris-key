// Where a browser keeps the Cloud Sync root (plan-cloud-sync "Root storage": IndexedDB, a
// non-extractable HKDF key; Q8). The record holds a `CryptoKey`, never the bytes: structured clone
// stores the key object, and script on the page can derive from it but cannot read it back.
//
// A root or pin that cannot be read is an error, never an absent record: a read fault is
// `store-failed`, a record that is there but not a usable root is `device-keys-unreadable`, and a
// delete that fails inside an opened database throws, so sign-out never reports a root gone that
// is still stored.
//
// A vault that cannot keep a record (no IndexedDB, or an engine that accepts the write and keeps
// nothing, as WebKit does for some keys) reports "memory" and holds the record for the page's
// life. The engine also picks the memory vault when the device keys are memory-only: a browser
// that cannot keep its own identity does not keep the root either, and unlocks with the recovery
// code at every load.

import {
  deriveChunkIdKey,
  deriveKid,
  deriveCollKey,
  deriveNamesKey,
  webCryptoSyncPort,
  type SyncCryptoPort,
} from "@polaris-key/client-core/sync";
import type { RingPersistence } from "../../core/keyring.js";
import { PolarisError } from "../../core/types.js";

/** What the vault keeps for the current ring's root. */
export interface StoredRoot {
  v: 1;
  ringId: string;
  epoch: number;
  /** The root's `kid`, 32 lowercase hex characters. */
  kid: string;
  /** HKDF, non-extractable, `deriveBits` only. */
  key: CryptoKey;
}

/**
 * Which ring this browser first acquired a root for (pinned at create, recover or unwrap). It
 * holds no secret. A served ring that differs is never adopted without the recovery code or an
 * explicit `acceptRingChange()`.
 */
export interface RingPin {
  v: 1;
  ringId: string;
  epoch: number;
  /** The root's `kid`, 32 lowercase hex characters. */
  rootKid: string;
}

export function validPin(p: unknown): p is RingPin {
  const r = p as RingPin | null;
  return (
    !!r &&
    r.v === 1 &&
    typeof r.ringId === "string" &&
    Number.isSafeInteger(r.epoch) &&
    typeof r.rootKid === "string" &&
    /^[0-9a-f]{32}$/.test(r.rootKid)
  );
}

export interface RootVault {
  persistence(): RingPersistence;
  get(): Promise<StoredRoot | null>;
  put(rec: StoredRoot): Promise<void>;
  /** Drops the root only; the pin stays (a lock is not a sign-out). Answers `false` when its
   *  durable delete did not run (the store could not be opened), so a caller keeps the pin with it. */
  clear(): Promise<boolean | void>;
  /** The pin, kept beside the root (the same store, the same durability). */
  getPin(): Promise<RingPin | null>;
  putPin(pin: RingPin): Promise<void>;
  clearPin(): Promise<void>;
}

export function memoryRootVault(): RootVault {
  let cur: StoredRoot | null = null;
  let pin: RingPin | null = null;
  return {
    persistence: () => "memory",
    get: async () => cur,
    put: async (rec) => {
      cur = rec;
    },
    clear: async () => {
      cur = null;
    },
    getPin: async () => pin,
    putPin: async (p) => {
      pin = p;
    },
    clearPin: async () => {
      pin = null;
    },
  };
}

const STORE = "root";
const RECORD = "current";
const PIN = "pin";

/** Runs `f` in one transaction on the root store; resolves with its request's result once committed. */
function inTx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  f: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = f(tx.objectStore(STORE));
    const fail = () => reject(tx.error ?? req.error ?? new Error("indexeddb"));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = fail;
    tx.onabort = fail;
  });
}

function validRoot(rec: unknown): rec is StoredRoot {
  const r = rec as StoredRoot | null;
  return (
    !!r &&
    r.v === 1 &&
    typeof r.ringId === "string" &&
    Number.isSafeInteger(r.epoch) &&
    r.epoch >= 1 &&
    typeof r.kid === "string" &&
    /^[0-9a-f]{32}$/.test(r.kid) &&
    !!r.key &&
    r.key.type === "secret" &&
    r.key.algorithm?.name === "HKDF" &&
    r.key.extractable === false
  );
}

const storeFailed = (what: string): PolarisError =>
  new PolarisError("store-failed", `The key ring store could not ${what}.`);

/**
 * IndexedDB vault `name` (one per product). A write is read back; a store that keeps nothing
 * degrades this vault to memory for the rest of the page, and `persistence()` says so. A read
 * that faults is `store-failed` (it never reads as an absent record), and a failed delete in an
 * opened database throws.
 */
export function indexedDbRootVault(
  name: string,
  idb: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory })
    .indexedDB,
  base: SyncCryptoPort = webCryptoSyncPort,
): RootVault {
  const mem = memoryRootVault();
  let degraded = idb === undefined;
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise<IDBDatabase>((res, rej) => {
      const req = idb!.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error ?? new Error("indexeddb"));
      req.onblocked = () => rej(new Error("indexeddb blocked"));
    });
    // A failed open is not cached: the next call opens again.
    db.catch(() => {
      db = null;
    });
    return db;
  };
  const read = async (key: string): Promise<unknown> =>
    inTx(await open(), "readonly", (st) => st.get(key));
  /** Reads `key`; a fault is `store-failed` and drops the cached connection. */
  const readChecked = async (key: string): Promise<unknown> => {
    try {
      return await read(key);
    } catch {
      db = null;
      throw storeFailed("read the stored value");
    }
  };
  /** Deletes `key`. Silent only when no database can be opened (then `false`); a failed delete
   *  throws. */
  const remove = async (key: string): Promise<boolean> => {
    if (idb === undefined) return true;
    let d: IDBDatabase;
    try {
      d = await open();
    } catch {
      return false; // nothing in the store is reachable: root and pin stay together
    }
    try {
      await inTx(d, "readwrite", (st) => st.delete(key));
    } catch {
      throw storeFailed("remove the stored value");
    }
    return true;
  };
  return {
    persistence: () => (degraded ? "memory" : "durable"),
    async get() {
      if (degraded) return mem.get();
      const rec = await readChecked(RECORD);
      if (rec === undefined || rec === null) return null;
      if (!validRoot(rec))
        throw new PolarisError(
          "device-keys-unreadable",
          "The stored key ring root is not a usable key.",
        );
      // The record's kid is checked against the handle itself: a key planted under the ring's
      // triple does not read as that ring's root.
      let derived: string;
      try {
        derived = hexOf(await deriveKid(portOver(rec.key, base), ROOT_IKM));
      } catch {
        throw new PolarisError(
          "device-keys-unreadable",
          "The stored key ring root is not a usable key.",
        );
      }
      if (derived !== rec.kid)
        throw new PolarisError(
          "device-keys-unreadable",
          "The stored key ring root is not the key it names.",
        );
      return {
        v: 1,
        ringId: rec.ringId,
        epoch: rec.epoch,
        kid: rec.kid,
        key: rec.key,
      };
    },
    async put(rec) {
      if (!degraded) {
        try {
          await inTx(await open(), "readwrite", (st) => st.put(rec, RECORD));
          if (validRoot(await read(RECORD))) return;
        } catch {
          // fall through to memory
        }
        degraded = true;
      }
      await mem.put(rec);
    },
    async clear() {
      await mem.clear();
      return remove(RECORD);
    },
    async getPin() {
      if (degraded) return mem.getPin();
      const rec = await readChecked(PIN);
      return validPin(rec) ? rec : null;
    },
    async putPin(p) {
      // The memory copy always follows, so a store that keeps nothing still pins for the page.
      await mem.putPin(p);
      if (degraded) return;
      try {
        await inTx(await open(), "readwrite", (st) => st.put(p, PIN));
      } catch {
        degraded = true;
      }
    },
    async clearPin() {
      await remove(PIN);
      await mem.clearPin();
    },
  };
}

/** The non-extractable handle for `root` (32 bytes). The caller zeroes its bytes afterwards. */
export function importRootHandle(
  root: Uint8Array,
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<CryptoKey> {
  return subtle.importKey("raw", Uint8Array.from(root), "HKDF", false, [
    "deriveBits",
  ]);
}

// ── Derived keys for the codec ───────────────────────────────────────────────────────────────

const ROOT_IKM = new Uint8Array(32);
const hexOf = (b: Uint8Array): string =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** A port whose HKDF from the sentinel root input runs on the handle, never on bytes. */
function portOver(handle: CryptoKey, base: SyncCryptoPort): SyncCryptoPort {
  return {
    ...base,
    async hkdf(ikm, salt, info, length) {
      if (ikm !== ROOT_IKM) {
        // The placeholder is recognised by identity. A copy of it (slice, Uint8Array.from, a new
        // use of the root) would derive from 32 zero bytes, a publicly known key: refuse instead.
        if (ikm.length === 32 && ikm.every((b) => b === 0))
          throw new Error("the placeholder root reached a derivation by value");
        return base.hkdf(ikm, salt, info, length);
      }
      return new Uint8Array(
        await globalThis.crypto.subtle.deriveBits(
          {
            name: "HKDF",
            hash: "SHA-256",
            salt: Uint8Array.from(salt),
            info: Uint8Array.from(info),
          },
          handle,
          length * 8,
        ),
      );
    },
  };
}

/**
 * The keys the sealing codec takes (`pkey-sync-value/1`, blinded names, chunk ids), derived from
 * the root handle. They are sub-keys: each seals one collection, and none opens another.
 */
export interface RingKeys {
  /** `kid` as 32 lowercase hex characters (also the ring's `rootKid`). */
  kid: string;
  ringId: string;
  epoch: number;
  collKey(collection: string): Promise<Uint8Array>;
  namesKey(): Promise<Uint8Array>;
  chunkIdKey(collection: string): Promise<Uint8Array>;
  /**
   * Runs `f` with a crypto port and a placeholder root input: the port derives from the vault's
   * non-extractable handle whenever it is given that input, so client-core's sealing functions run
   * unchanged and the root's bytes are never read. The placeholder is not the root.
   */
  withRoot<T>(
    f: (port: SyncCryptoPort, root: Uint8Array) => Promise<T>,
  ): Promise<T>;
}

export function ringKeysOf(
  rec: StoredRoot,
  base: SyncCryptoPort = webCryptoSyncPort,
): RingKeys {
  const p = portOver(rec.key, base);
  return {
    kid: rec.kid,
    ringId: rec.ringId,
    epoch: rec.epoch,
    collKey: (c) => deriveCollKey(p, ROOT_IKM, c),
    namesKey: () => deriveNamesKey(p, ROOT_IKM),
    chunkIdKey: (c) => deriveChunkIdKey(p, ROOT_IKM, c),
    withRoot: (f) => f(p, ROOT_IKM),
  };
}
