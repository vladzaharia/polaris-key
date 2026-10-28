// The browser Cloud Sync host's state (U-20.2): one record in IndexedDB `pkey-sync-<product>`,
// written as one JSON string. It holds the machine's journal (`CloudSyncMachine.persist()`), the
// catalog last served by `/config/schema` and the names of the person's open settings, as sdk-node's
// `cloud-sync.json` does.
//
// The record holds the WHOLE opened snapshot of the signed-in person's settings in the clear, so
// sign-out, deactivation and `account_required` delete it (`removeSyncState`), in the same flow as
// `keyring.forget()`. It never holds the root: that stays in the ring's vault.
//
// `rev` orders the record. A writer only stores a record whose `rev` is above the stored one, read
// again inside the lock, so a slower or older writer can never put a lower state over a newer one
// (R-6w).

import type { CloudSyncPersisted } from "@polaris-key/client-core/cloud-sync";
import type { ProductCatalog } from "@polaris-key/catalog";
import {
  indexedDbConnectState,
  memoryConnectState,
  type ConnectStateStore,
} from "../connect/state.js";

/** The record's store; the same shape the Connect record uses. */
export type SyncStateStore = ConnectStateStore;

export const SYNC_STATE_SCHEMA = "pkey.cloudsync.v1";
/** Open-setting names kept for tombstone mapping; past this the oldest are dropped. */
export const OPEN_KEYS_MAX = 4096;

export interface SyncStateRecord {
  schema: typeof SYNC_STATE_SCHEMA;
  product: string;
  /** Orders writes; a record is replaced only by a higher one. */
  rev: number;
  persisted: CloudSyncPersisted | null;
  /** The last served catalog: it may only add keys the compiled mirror lacks. */
  catalog: ProductCatalog | null;
  openKeys: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The catalog's outer shape; the host vets the rest before routing by it. */
export const isCatalogShape = (v: unknown): v is ProductCatalog =>
  isRecord(v) &&
  typeof v.schemaVersion === "number" &&
  Array.isArray(v.entries);

/** The record, or null when the text is not a usable record of this product. */
export function parseSyncState(
  raw: string,
  product: string,
): SyncStateRecord | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !isRecord(v) ||
    v.schema !== SYNC_STATE_SCHEMA ||
    v.product !== product ||
    !Number.isSafeInteger(v.rev) ||
    (v.rev as number) < 0
  )
    return null;
  const p = v.persisted;
  const persisted =
    isRecord(p) &&
    isRecord(p.partitions) &&
    Array.isArray(p.hlc) &&
    typeof p.contacted === "boolean"
      ? (p as unknown as CloudSyncPersisted)
      : null;
  return {
    schema: SYNC_STATE_SCHEMA,
    product,
    rev: v.rev as number,
    persisted,
    catalog: isCatalogShape(v.catalog) ? v.catalog : null,
    openKeys: Array.isArray(v.openKeys)
      ? v.openKeys
          .filter((k): k is string => typeof k === "string")
          .slice(-OPEN_KEYS_MAX)
      : [],
  };
}

export const emptySyncState = (product: string): SyncStateRecord => ({
  schema: SYNC_STATE_SCHEMA,
  product,
  rev: 0,
  persisted: null,
  catalog: null,
  openKeys: [],
});

/** The database name for one product (the namespace is empty for the production host). */
export const syncDbName = (namespace: string): string =>
  `pkey-sync-${namespace}`;

/** IndexedDB database `name`, or memory where the page has no IndexedDB. */
export function syncStateStore(
  name: string,
  idb?: IDBFactory | undefined,
): SyncStateStore {
  const factory =
    idb ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? undefined;
  return factory === undefined
    ? memoryConnectState()
    : indexedDbConnectState(name, factory);
}

/**
 * Delete the record. Throws if it is still there after: a purge that did not purge must reach the
 * caller. Where the database is known to be absent (nothing was ever stored) there is nothing to
 * delete and nothing is created.
 */
export async function removeSyncState(store: SyncStateStore): Promise<void> {
  if (store.mayHold && !(await store.mayHold())) return;
  await store.clear();
  if ((await store.get()) !== null)
    throw new Error("the Cloud Sync state could not be deleted");
}
