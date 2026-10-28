// Cloud Sync as the React adapters expose it (sync.settings, U-20.2). One client per adapter: the
// browser's bearer mode runs the host (`browser/cloudSync/host.ts`), loaded on the first call that
// needs it so a page that never syncs pays only for this file. A cookie page, the desktop bridge
// (until bridge v4 carries the verbs, D-6) and the local adapter answer the typed unsupported one
// below; `unsupported` says which.
//
// Nothing here imports the host's code: the licence path and the initial chunk never reach it.

import type { Unsupported } from "@polaris-key/client-core";
import type {
  SyncEvent,
  SyncStatus,
} from "@polaris-key/client-core/cloud-sync";
import type { BrowserCloudSyncHost } from "../browser/cloudSync/host.js";
import { Feature } from "../constants.generated.js";
import { UnsupportedError } from "./caps.js";

export type { SyncEvent, SyncStatus };

/** Cloud Sync for settings. The host's machine API (`set`, `get`, `settingState`, `signIn`, ...)
 *  is `host()`'s; app code reads status and flushes. */
export interface CloudSyncClient {
  /** Why Cloud Sync is unavailable on this transport, or null when it runs. */
  readonly unsupported: Unsupported | null;
  /** Loads the host, restores the journal and joins the writer election. Idempotent. Throws the
   *  typed `UnsupportedError` where it cannot run (no Web Locks; a product without Sync). */
  host(): Promise<BrowserCloudSyncHost>;
  /** The machine's status; `local` before the host has loaded. */
  status(): SyncStatus;
  /** Send what is waiting now (bounded) and save the journal. */
  flush(): Promise<SyncStatus>;
  /**
   * Delete the synced data of the person on this device (the record in IndexedDB) and forget it in
   * memory, in every tab. Sign-out, deactivation and `account_required` call it beside
   * `keyring.forget()`. Throws if the record is still there after. Where nothing is held (the host
   * never ran and no database exists) there is nothing to do.
   */
  purge(): Promise<void>;
  /** The machine's events, in order; subscribing before the host loads is fine. */
  onEvents(listener: (events: SyncEvent[]) => void): () => void;
}

/** A client for a transport that cannot run Cloud Sync: every verb throws the typed unsupported. */
export function unsupportedCloudSync(
  reason: Unsupported["reason"],
  detail: string,
): CloudSyncClient {
  const unsupported: Unsupported = {
    supported: false,
    feature: Feature.syncSettings,
    reason,
    detail,
  };
  const refuse = (): never => {
    throw new UnsupportedError(unsupported);
  };
  return {
    unsupported,
    host: () => Promise.reject(new UnsupportedError(unsupported)),
    status: refuse,
    flush: () => Promise.reject(new UnsupportedError(unsupported)),
    // Nothing can be held here, so there is nothing to delete.
    purge: async () => undefined,
    onEvents: () => () => undefined,
  };
}

export interface LazyCloudSyncSource {
  /** Runs once: builds and starts the host (dynamic imports) and answers the loaded client. */
  load(): Promise<CloudSyncClient>;
  /** Whether the product runs the Sync service; if not, every verb throws the typed N/A. */
  enabled(): boolean;
  /** The IndexedDB database the host's record lives in (`pkey-sync-<product>`). */
  dbName: string;
}

/** A thin stub: nothing but forwarding. The first call that needs the host loads the client. */
export function lazyCloudSync(src: LazyCloudSyncSource): CloudSyncClient {
  let real: CloudSyncClient | null = null;
  let loading: Promise<CloudSyncClient> | null = null;
  const listeners = new Set<(events: SyncEvent[]) => void>();
  // A product that does not run the Sync service answers the typed N/A on every verb.
  const off = () =>
    unsupportedCloudSync(
      "product",
      "the product does not run the Sync service",
    );
  const ready = (): Promise<CloudSyncClient> =>
    src.enabled()
      ? (loading ??= src.load().then(
          (c) => (
            c.onEvents((e) => listeners.forEach((l) => l(e))),
            (real = c)
          ),
          (err) => ((loading = null), Promise.reject(err)),
        ))
      : (off().host() as Promise<never>);
  return {
    unsupported: null,
    host: async () => (await ready()).host(),
    status: () =>
      !src.enabled()
        ? off().status()
        : real
          ? real.status()
          : { state: "local", pending: 0 },
    flush: async () => (await ready()).flush(),
    async purge() {
      // A load in flight is waited for, so its record is not written after the purge.
      const c = real ?? (await loading?.catch(() => null)) ?? null;
      if (c) return c.purge();
      // The host never ran: delete the record without starting anything.
      const m = await import("../browser/cloudSync/store.js");
      await m.removeSyncState(m.syncStateStore(src.dbName));
    },
    onEvents: (l) => (listeners.add(l), () => listeners.delete(l)),
  };
}
