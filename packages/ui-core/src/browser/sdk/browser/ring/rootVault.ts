// Where a browser keeps the Cloud Sync root (plan-cloud-sync "Root storage": IndexedDB, a
// non-extractable HKDF key; Q8). The record holds a `CryptoKey`, never the bytes: structured clone
// stores the key object, and script on the page can derive from it but cannot read it back.
//
// A vault that cannot keep a record (no IndexedDB, or an engine that accepts the write and keeps
// nothing, as WebKit does for some keys) reports "memory" and holds the record for the page's
// life. The engine also picks the memory vault when the device keys are memory-only: a browser
// that cannot keep its own identity does not keep the root either, and unlocks with the recovery
// code at every load.

import {
  deriveChunkIdKey,
  deriveCollKey,
  deriveNamesKey,
  webCryptoSyncPort,
  type SyncCryptoPort,
} from "@polaris-key/client-core/sync";
import type { RingPersistence } from "../../core/keyring.js";

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

export interface RootVault {
  persistence(): RingPersistence;
  get(): Promise<StoredRoot | null>;
  put(rec: StoredRoot): Promise<void>;
  clear(): Promise<void>;
}

export function memoryRootVault(): RootVault {
  let cur: StoredRoot | null = null;
  return {
    persistence: () => "memory",
    get: async () => cur,
    put: async (rec) => {
      cur = rec;
    },
    clear: async () => {
      cur = null;
    },
  };
}

const STORE = "root";
const RECORD = "current";

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

/**
 * IndexedDB vault `name` (one per product). A write is read back; a store that keeps nothing
 * degrades this vault to memory for the rest of the page, and `persistence()` says so.
 */
export function indexedDbRootVault(
  name: string,
  idb: IDBFactory | undefined = (globalThis as { indexedDB?: IDBFactory })
    .indexedDB,
): RootVault {
  const mem = memoryRootVault();
  let degraded = idb === undefined;
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise((res, rej) => {
      const req = idb!.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error ?? new Error("indexeddb"));
      req.onblocked = () => rej(new Error("indexeddb blocked"));
    });
    return db;
  };
  const read = async (): Promise<unknown> =>
    inTx(await open(), "readonly", (st) => st.get(RECORD));
  return {
    persistence: () => (degraded ? "memory" : "durable"),
    async get() {
      if (degraded) return mem.get();
      try {
        const rec = await read();
        // A record that exists but is not a usable root is dropped: it can only be a stale or
        // damaged copy, and a root is re-obtained from the ring, never repaired here.
        return validRoot(rec) ? rec : null;
      } catch {
        degraded = true;
        return mem.get();
      }
    },
    async put(rec) {
      if (!degraded) {
        try {
          await inTx(await open(), "readwrite", (st) => st.put(rec, RECORD));
          if (validRoot(await read())) return;
        } catch {
          // fall through to memory
        }
        degraded = true;
      }
      await mem.put(rec);
    },
    async clear() {
      await mem.clear();
      if (idb === undefined) return;
      try {
        await inTx(await open(), "readwrite", (st) => st.delete(RECORD));
      } catch {
        // nothing durable to clear
      }
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

/** A port whose HKDF from the sentinel root input runs on the handle, never on bytes. */
function portOver(handle: CryptoKey, base: SyncCryptoPort): SyncCryptoPort {
  return {
    ...base,
    async hkdf(ikm, salt, info, length) {
      if (ikm !== ROOT_IKM) return base.hkdf(ikm, salt, info, length);
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
  };
}
