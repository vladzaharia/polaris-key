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

/** What the adapter tells Cloud Sync about the person: who signed in, or that they left. */
export type IdentityNote =
  | { kind: "signedIn"; subject: string }
  | { kind: "signedOut" };

/** Cloud Sync for settings. The host's machine API (`set`, `get`, `settingState`, `signIn`, ...)
 *  is `host()`'s; app code reads status and flushes. */
export interface CloudSyncClient {
  /** Why Cloud Sync is unavailable on this transport, or null when it runs. */
  readonly unsupported: Unsupported | null;
  /** The Worker's origin: a sign-in offer is only handed on when it is on it. */
  readonly signInOrigin?: string;
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
  /** The status may have moved (a send finished, a record was followed); read `status()`. */
  onStatus(listener: () => void): () => void;
  /**
   * The adapter's wiring (not app code): load and start Cloud Sync, take the stored subject and
   * route `config.set` through the machine. Idempotent; a no-op where Cloud Sync cannot run.
   */
  attach(): Promise<void>;
  /** The adapter's wiring: the identity session's events drive the machine. */
  identity(note: IdentityNote): Promise<void>;
  /** The adapter's wiring, run before sign-out: send what is waiting (bounded), then leave. */
  beforeSignOut(): Promise<void>;
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
    onStatus: () => () => undefined,
    // Nothing runs here, so there is nothing to wire.
    attach: async () => undefined,
    identity: async () => undefined,
    beforeSignOut: async () => undefined,
  };
}

export interface LazyCloudSyncSource {
  /** Runs once: builds and starts the host (dynamic imports) and answers the loaded client. */
  load(): Promise<CloudSyncClient>;
  /** Whether the product runs the Sync service; if not, every verb throws the typed N/A. */
  enabled(): boolean;
  /** The IndexedDB database the host's record lives in (`pkey-sync-<product>`). */
  dbName: string;
  /** The Worker's origin. */
  signInOrigin?: string;
}

/** A thin stub: nothing but forwarding. The first call that needs the host loads the client. */
export function lazyCloudSync(src: LazyCloudSyncSource): CloudSyncClient {
  let real: CloudSyncClient | null = null;
  let loading: Promise<CloudSyncClient> | null = null;
  const listeners = new Set<(events: SyncEvent[]) => void>();
  const statusListeners = new Set<() => void>();
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
            c.onStatus(() => statusListeners.forEach((l) => l())),
            (real = c)
          ),
          (err) => ((loading = null), Promise.reject(err)),
        ))
      : (off().host() as Promise<never>);
  return {
    unsupported: null,
    ...(src.signInOrigin !== undefined
      ? { signInOrigin: src.signInOrigin }
      : {}),
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
      await (
        await import("../browser/cloudSync/purge.js")
      ).purgeUnloaded(src.dbName);
    },
    onEvents: (l) => (listeners.add(l), () => listeners.delete(l)),
    onStatus: (l) => (statusListeners.add(l), () => statusListeners.delete(l)),
    attach: async () => {
      if (src.enabled()) await (await ready()).attach();
    },
    identity: async (note) => {
      if (!src.enabled()) return;
      // Nothing loaded holds no person to leave.
      if (note.kind === "signedOut" && real === null && loading === null)
        return;
      await (await ready()).identity(note);
    },
    // Nothing loaded means nothing waiting: a page that never synced pays nothing to sign out.
    beforeSignOut: async () => {
      const c = real ?? (await loading?.catch(() => null)) ?? null;
      if (c) await c.beforeSignOut();
    },
  };
}
