// Device-id binding to the hardware anchor — wire contract §6.
//
// The stored device id is a plain file next to the token and the cache. Copy that directory to
// another machine and, before this, the clone kept the original's identity: the server saw one
// device, the licence document verified (it is bound to that id), and a revoked seat was
// resurrected by pasting the old state over the new. So the desktop file store no longer
// TRUSTS its stored id: at every start the id is re-derived from the platform anchor
// (`deviceIdFromRaw(product, raw)`, the same formula that minted it) and a stored id that
// disagrees is discarded together with the token and the grant slices of the cache — what
// `deactivate()` does, minus the network call. The device re-activates once; the server
// coalesces the stale seat by hardware id.
//
// WHAT IS KEPT: the update slices (`feeds`, `releaseRecords`) and anything else that is not a
// grant — they are public, signed, and carry anti-rollback floors, so dropping them would let
// a replayed older feed past. WHAT IS NOT BOUND: a store that cannot rewrite its id
// (`BindableStore`): the in-memory test store, a host's own store, and any host with no
// readable anchor, where the stored id is simply used.

import {
  CACHE_VERSION,
  type CacheRecordV3,
  type Store,
} from "@polaris-key/client-core";
import { deviceIdFromRaw } from "../devices/deviceId.js";

/** A store whose device id can be rewritten and which knows its anchor: the desktop file
 *  stores (`FileStore`, `KeyringStore`, `SafeStorageStore`). */
export interface BindableStore extends Store {
  /** The raw platform anchor, or null when none is readable. */
  readAnchor(): string | null;
  setDeviceId(id: string): Promise<void>;
}

export function isBindable(store: Store): store is BindableStore {
  const s = store as Partial<BindableStore>;
  return (
    typeof s.setDeviceId === "function" && typeof s.readAnchor === "function"
  );
}

/** The cache keys that are GRANTS (or derive from one): dropped when the id changes. Everything
 *  else — the update slices and any later non-grant slice — is carried over. */
const GRANT_KEYS = [
  "trustJws",
  "docs",
  "etags",
  "bundle",
  "lastSyncUnauthorized",
  "blocked",
] as const;

/**
 * Re-derive the device id from the anchor and reconcile the store with it. Returns the id the
 * client must use, and whether a disagreeing stored id was discarded.
 */
export async function bindDeviceId(
  product: string,
  store: Store,
): Promise<{ deviceId: string; discarded: boolean }> {
  const stored = await store.getDeviceId();
  if (!isBindable(store)) return { deviceId: stored, discarded: false };
  const raw = store.readAnchor();
  if (raw === null) return { deviceId: stored, discarded: false };
  const derived = deviceIdFromRaw(product, raw);
  if (derived === stored) return { deviceId: stored, discarded: false };

  // Token first: a crash between the steps must not leave a foreign token beside a new id.
  await store.clearToken();
  const rec = await store.readCache();
  if (rec) {
    const kept: Record<string, unknown> = { ...rec };
    for (const k of GRANT_KEYS) delete kept[k];
    if (Object.keys(kept).some((k) => k !== "v"))
      await store.writeCache({ ...kept, v: CACHE_VERSION } as CacheRecordV3);
    else await store.clearCache();
  }
  await store.setDeviceId(derived);
  return { deviceId: derived, discarded: true };
}
