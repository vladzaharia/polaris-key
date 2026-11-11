// Cloud Sync as the React adapters expose it (sync.settings, U-20.2). One client per adapter: the
// browser's bearer mode runs the host (`browser/cloudSync/host.ts`), loaded on the first call that
// needs it so a page that never syncs pays only for this file. A page without pinned keys, the desktop bridge
// (until bridge v4 carries the verbs, D-6) and the local adapter answer the typed unsupported one
// below; `unsupported` says which.
//
// Nothing here imports the host's code: the licence path and the initial chunk never reach it.

import type { Unsupported } from "@polaris-key/client-core";
import type {
  ConflictListener,
  MergeRequest,
  MergeStreamEvent,
  RangedSource,
  ReadOptions,
  SaveTransferEvent,
  SaveRead,
  SaveSetResult,
  SaveSummary,
  SaveTransfer,
  WriteOptions,
} from "@polaris-key/client-core/sync";
import type {
  CloudSyncExport,
  SyncCollection,
} from "@polaris-key/client-core/sync";
import type { FileRevision } from "@polaris-key/protocol/sync";
import type { Json } from "@polaris-key/client-core/cloud-sync";
import type {
  SyncEvent,
  SyncStatus,
} from "@polaris-key/client-core/cloud-sync";
import type { BrowserCloudSyncHost } from "../browser/cloudSync/host.js";
import { Feature } from "../constants.generated.js";
import { UnsupportedError } from "./caps.js";

export type {
  ConflictListener,
  MergeRequest,
  SaveTransferEvent,
  SyncEvent,
  SyncStatus,
};

/** A MergeRequest event on the `cloudSync` stream (`MergeEvent` in `conformance/parity/enums.json`). */
export type ConflictStreamEvent = MergeStreamEvent;

/** What `onEvents` delivers: the machine's events and the MergeRequest ones. */
export type CloudSyncEvent = SyncEvent | ConflictStreamEvent;

/** What the adapter tells Cloud Sync about the person: who signed in, or that they left. */
export type IdentityNote =
  | { kind: "signedIn"; subject: string }
  | { kind: "signedOut" };

/** What `cloudSync.export()` takes in a browser (sync.export, WIRE-CONTRACT-V5 §13.12). */
export interface BrowserExportOptions {
  /** Also write each file's kept revisions (default false). */
  includeRevisions?: boolean;
  /** Abort the export: nothing is kept, a `sink` is aborted, and the call rejects with `cancelled`. */
  signal?: AbortSignal;
  /**
   * Where to stream the archive, for instance the writable of a `showSaveFilePicker()` handle.
   * Without it the archive is built in memory as a Blob (at most 256 MiB: a larger export is
   * refused, `sync-export-too-large`, before anything is read). The SDK writes to it and closes
   * it, aborts it on an error or a cancel, and never keeps it.
   */
  sink?: WritableStream<Uint8Array>;
}

/** What `cloudSync.export()` answers: the archive's facts, and the Blob when no `sink` was given.
 *  The SDK keeps neither the Blob nor the sink once the call settles; revoke any object URL you make. */
export type BrowserExport = CloudSyncExport & { blob?: Blob };

/**
 * The saves of the signed-in person (sync.saves, U-22.7): records with one file each, over Cloud
 * Sync. Loaded on the first call. Where Cloud Sync cannot run every verb throws the typed
 * unsupported. Only the writer tab can write, delete or keep (`sync-not-writer` otherwise).
 */
export interface BrowserSaves {
  list(): Promise<SaveSummary[]>;
  read(id: string, opts?: ReadOptions): Promise<SaveRead>;
  /** Resolves with a handle at once; `done` settles on done, cancelled, failed or conflict. */
  write(
    id: string,
    bytes: Uint8Array | RangedSource,
    metadata: { [k: string]: Json },
    opts?: WriteOptions,
  ): Promise<SaveTransfer>;
  delete(id: string, baseVersion?: number): Promise<SaveSetResult>;
  revisions(id: string): Promise<FileRevision[]>;
  /** The writes in flight (running, paused or waiting). Empty before the saves have loaded. */
  transfers(): SaveTransfer[];
  /** The save requests open now (`request.keep` settles one). Empty before the saves have loaded. */
  conflicts(): MergeRequest[];
  /** Transfer events in order; `null` when the set of transfers changed. */
  onTransfers(listener: (event: SaveTransferEvent | null) => void): () => void;
  /** The adapter's wiring: the person's transfers, journal and chunk cache are gone. */
  purge(): Promise<void>;
}

/** Cloud Sync for settings. The host's machine API (`set`, `get`, `settingState`, `signIn`, ...)
 *  is `host()`'s; app code reads status and flushes. */
export interface CloudSyncClient {
  /** Why Cloud Sync is unavailable on this transport, or null when it runs. */
  readonly unsupported: Unsupported | null;
  /** The Worker's origin: a sign-in offer is only handed on when it is on it. */
  readonly signInOrigin?: string;
  /** The saves of the signed-in person (sync.saves). */
  readonly saves: BrowserSaves;
  /** Loads the host, restores the journal and joins the writer election. Idempotent. Throws the
   *  typed `UnsupportedError` where it cannot run (no Web Locks; a product without Sync). */
  host(): Promise<BrowserCloudSyncHost>;
  /** The machine's status; `local` before the host has loaded. */
  status(): SyncStatus;
  /** Send what is waiting now (bounded) and save the journal. */
  flush(): Promise<SyncStatus>;
  /**
   * The records handle of a collection the product's catalog declares (sync.records). Loads the
   * host. An undeclared name answers `collection_unknown` from each call. Only the writer tab
   * writes (`sync-not-writer` otherwise). Throws the typed unsupported where Cloud Sync cannot run.
   */
  collection(name: string): Promise<SyncCollection>;
  /**
   * Delete the synced data of the person on this device (the record in IndexedDB) and forget it in
   * memory, in every tab. Sign-out, deactivation and `account_required` call it beside
   * `keyring.forget()`. Throws if the record is still there after. Where nothing is held (the host
   * never ran and no database exists) there is nothing to do.
   */
  purge(): Promise<void>;
  /** The machine's events, in order; subscribing before the host loads is fine. */
  onEvents(listener: (events: CloudSyncEvent[]) => void): () => void;
  /**
   * Listen for MergeRequests as they open (`revision` conflicts the app has not decided); the ones
   * already open are replayed. A listener that returns a choice decides the request at once.
   * Loads nothing: it follows the host once the host has loaded.
   */
  onConflict(listener: ConflictListener): () => void;
  /** The requests open now, in id order; each keeps the device's copy unsent until `keep`. */
  conflicts(): MergeRequest[];
  /** Whether the cloud held nothing at the person's first pull; `null` before one (or signed out). */
  cloudEmpty(): boolean | null;
  /**
   * Make a readable, NOT encrypted copy of the synced data (sync.export): a zip as a Blob, or
   * streamed into `options.sink`. Say so to the person first. Refuses with `account_required`,
   * `sync-locked`, `sync-encryption-pinned`, `cancelled`, `sync-export-too-large` and
   * `sync-export-failed` (`reason` `destination`, `network` or `busy`: one export per client).
   * Throws the typed unsupported where Cloud Sync cannot run (the desktop bridge too).
   */
  export(options?: BrowserExportOptions): Promise<BrowserExport>;
  /** The status may have moved (a send finished, a record was followed); read `status()`. */
  onStatus(listener: () => void): () => void;
  /**
   * The adapter's wiring (not app code): load and start Cloud Sync, take the stored subject and
   * route `config.set` through the machine. Idempotent; a no-op where Cloud Sync cannot run.
   */
  attach(): Promise<void>;
  /** The adapter's wiring: the identity session's events drive the machine. */
  identity(note: IdentityNote): Promise<void>;
  /**
   * The adapter's wiring: a key-ring or file route answered `account_required` (WIRE-CONTRACT-V5
   * §11.5), `signInUrl` being the answer's, unvetted. The machine leaves the person the way a
   * `/sync` 403 does. Loads Cloud Sync; never throws into the route that saw it.
   */
  accountRequired(
    signInUrl: string | null,
    forSubject: string | null,
  ): Promise<void>;
  /** The adapter's wiring, run before sign-out: send what is waiting (bounded), then leave. */
  beforeSignOut(): Promise<void>;
}

/** The saves' own feature id on a transport that cannot run Cloud Sync. */
const savesUnsupported = (u: Unsupported): UnsupportedError =>
  new UnsupportedError({ ...u, feature: Feature.syncSaves });

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
  const saves: BrowserSaves = {
    list: () => Promise.reject(savesUnsupported(unsupported)),
    read: () => Promise.reject(savesUnsupported(unsupported)),
    write: () => Promise.reject(savesUnsupported(unsupported)),
    delete: () => Promise.reject(savesUnsupported(unsupported)),
    revisions: () => Promise.reject(savesUnsupported(unsupported)),
    transfers: () => [],
    conflicts: () => [],
    onTransfers: () => () => undefined,
    purge: async () => undefined,
  };
  return {
    unsupported,
    saves,
    host: () => Promise.reject(new UnsupportedError(unsupported)),
    status: refuse,
    flush: () => Promise.reject(new UnsupportedError(unsupported)),
    collection: () =>
      Promise.reject(
        new UnsupportedError({ ...unsupported, feature: Feature.syncRecords }),
      ),
    // Nothing can be held here, so there is nothing to delete.
    purge: async () => undefined,
    onEvents: () => () => undefined,
    onConflict: () => () => undefined,
    conflicts: () => [],
    cloudEmpty: () => null,
    export: () =>
      Promise.reject(
        new UnsupportedError({ ...unsupported, feature: Feature.syncExport }),
      ),
    onStatus: () => () => undefined,
    // Nothing runs here, so there is nothing to wire.
    attach: async () => undefined,
    identity: async () => undefined,
    beforeSignOut: async () => undefined,
    accountRequired: async () => undefined,
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
  const listeners = new Set<(events: CloudSyncEvent[]) => void>();
  // A conflict listener follows the host once it has loaded (the remover is null until then).
  const conflictListeners = new Map<ConflictListener, (() => void) | null>();
  const statusListeners = new Set<() => void>();
  const transferListeners = new Set<(e: SaveTransferEvent | null) => void>();
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
            c.saves.onTransfers((e) => transferListeners.forEach((l) => l(e))),
            conflictListeners.forEach((off, l) => {
              if (off === null) conflictListeners.set(l, c.onConflict(l));
            }),
            (real = c)
          ),
          (err) => ((loading = null), Promise.reject(err)),
        ))
      : (off().host() as Promise<never>);
  const saves: BrowserSaves = {
    list: async () => (await ready()).saves.list(),
    read: async (id, o) => (await ready()).saves.read(id, o),
    write: async (id, b, m, o) => (await ready()).saves.write(id, b, m, o),
    delete: async (id, v) => (await ready()).saves.delete(id, v),
    revisions: async (id) => (await ready()).saves.revisions(id),
    transfers: () => real?.saves.transfers() ?? [],
    conflicts: () => real?.saves.conflicts() ?? [],
    onTransfers: (l) => (
      transferListeners.add(l),
      () => transferListeners.delete(l)
    ),
    purge: async () => {
      const c = real ?? (await loading?.catch(() => null)) ?? null;
      await c?.saves.purge();
    },
  };
  return {
    unsupported: null,
    saves,
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
    collection: async (name) =>
      src.enabled() ? (await ready()).collection(name) : off().collection(name),
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
    onConflict: (l) => {
      conflictListeners.set(l, real ? real.onConflict(l) : null);
      // A listener means the app syncs: the host loads now, as it would for any other verb.
      if (!real && src.enabled()) void ready().catch(() => undefined);
      return () => {
        conflictListeners.get(l)?.();
        conflictListeners.delete(l);
      };
    },
    conflicts: () => real?.conflicts() ?? [],
    cloudEmpty: () => real?.cloudEmpty() ?? null,
    export: async (o) =>
      src.enabled()
        ? (await ready()).export(o)
        : (off().export(o) as Promise<never>),
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
    accountRequired: async (url, forSubject) => {
      if (src.enabled()) await (await ready()).accountRequired(url, forSubject);
    },
  };
}
