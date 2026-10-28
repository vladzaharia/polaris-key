// The browser Cloud Sync settings API (U-20.3): what app code sees on top of the host
// (`host.ts`), the counterpart of sdk-node's `cloudSync/api.ts`.
//
//   adapter.cloudSync.status() / flush()      the machine's status, and "send what is waiting"
//   adapter.cloudSync.onEvents(fn)            the machine's events, in order
//   config.set / clear / setting(k).sync()    routed through the machine while a principal is held
//
// The identity session drives the machine: a stored or new subject signs it in, a sign-out flushes
// (bounded) and signs it out. Rules kept here (plans/U-sync-clients-slices.md section 9):
//   S6  When the machine leaves a principal (`signOut`, `accountRequired`, `subjectChanged`) the
//       key ring is forgotten and the record deleted (the host does both, root first). A failure
//       is logged and never replaces the sign-out's own error. The sign-in offer follows.
//   S7  No event, log line or error here carries a value or the root; events name keys only.
//   SEC-HOST2  A subject that could not be read (offline) is not a sign-out: nothing is forgotten
//       on a guess.
// Licence state is never read or written from this module. Loaded with the host, on first use.

import {
  SYNC_SIGNOUT_FLUSH_MS,
  type CallResult,
  type Json,
  type SyncEvent,
  type SyncStatus,
} from "@polaris-key/client-core/cloud-sync";
import type { CloudSyncClient, IdentityNote } from "../../core/cloudSync.js";
import type {
  ConfigSyncPort,
  LocalConfigEngine,
} from "../../core/localConfig.js";
import type { KeyringClient } from "../../core/keyring.js";
import type { BrowserCloudSyncHost } from "./host.js";

/** The reasons the machine leaves a principal, each of which drops the key ring. */
const FORGETTING = new Set(["signOut", "accountRequired", "subjectChanged"]);

/** Whether the legacy device-local values were offered once on this install. Its own marker: a
 *  purge resets the machine's flag and the record, and must not let the next person inherit them. */
export interface ImportMarker {
  get(): boolean;
  set(): void;
}

/** The marker in `localStorage` (every access in try/catch), or in memory where there is none. */
export function importMarker(
  name: string,
  storage?: Pick<Storage, "getItem" | "setItem"> | null,
): ImportMarker {
  let store: Pick<Storage, "getItem" | "setItem"> | null = null;
  try {
    store =
      storage === undefined
        ? typeof globalThis.localStorage === "undefined"
          ? null
          : globalThis.localStorage
        : storage;
  } catch {
    store = null;
  }
  let mem = false;
  return {
    get() {
      if (mem) return true;
      try {
        return store?.getItem(name) === "1";
      } catch {
        return false;
      }
    },
    set() {
      mem = true;
      try {
        store?.setItem(name, "1");
      } catch {
        // Memory still holds it for this page.
      }
    },
  };
}

export interface BrowserCloudSyncApiDeps {
  host: BrowserCloudSyncHost;
  keyring: Pick<KeyringClient, "forget">;
  config: Pick<LocalConfigEngine, "useSync" | "noteSyncChange" | "importable">;
  /** The signed-in person, null for none, undefined when it could not be read (a network failure
   *  is not a sign-out). */
  subject: () => Promise<string | null | undefined>;
  marker: ImportMarker;
  /** Diagnostics; never given a value or a secret. */
  log?: (message: string) => void;
}

export class BrowserCloudSyncApi {
  readonly #d: BrowserCloudSyncApiDeps;
  readonly #listeners = new Set<(events: SyncEvent[]) => void>();
  #attached: Promise<void> | null = null;
  #subject: string | null = null;
  #forgot = false;
  #chain: Promise<void> = Promise.resolve();
  /** Identity changes, one at a time and in order. */
  #work: Promise<void> = Promise.resolve();

  constructor(deps: BrowserCloudSyncApiDeps) {
    this.#d = deps;
  }

  // ── What app code calls ──────────────────────────────────────────────────────────────────

  status(): SyncStatus {
    return this.#d.host.started
      ? this.#d.host.machine.status()
      : { state: "local", pending: 0 };
  }

  async flush(): Promise<SyncStatus> {
    await this.attach();
    await this.#work;
    await this.#d.host.flush();
    await this.#chain;
    return this.status();
  }

  onEvents(fn: (events: SyncEvent[]) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  onStatus(fn: () => void): () => void {
    return this.#d.host.onStatus(fn);
  }

  // ── What the adapter calls ───────────────────────────────────────────────────────────────

  /** Start the host and sign the machine in as the stored subject. Idempotent. */
  attach(): Promise<void> {
    return (this.#attached ??= this.#start().catch((e) => {
      this.#attached = null;
      throw e;
    }));
  }

  async #start(): Promise<void> {
    const { host, config } = this.#d;
    await host.start();
    host.onEvents((events) => this.#onEvents(events));
    host.onPrincipal(() => void this.#recheck());
    config.useSync(this.#port());
    // A journal saved while signed in still names its subject.
    this.#subject = host.machine.persist().subject;
    if (this.#subject !== null) config.noteSyncChange(null, "remote");
    await this.#settle();
  }

  /** Ask the session who it is and follow it. An answer that could not be read changes nothing. */
  async #settle(): Promise<void> {
    const subject = await this.#d.subject().catch(() => undefined);
    if (subject === undefined) return;
    if (subject !== null) await this.#signIn(subject);
    else if (this.#subject !== null) await this.#leave();
  }

  #recheck(): Promise<void> {
    const run = this.#work.then(() => this.attach().then(() => this.#settle()));
    this.#work = run.catch(() => undefined);
    return run;
  }

  async #signIn(subject: string): Promise<void> {
    const { host, config } = this.#d;
    if (!host.started) return;
    // Another person: the first one is signed out (flushed, then forgotten) before this one starts.
    if (this.#subject !== null && this.#subject !== subject)
      await this.#signOutNow();
    if (this.#subject === subject) return;
    // Once per install, before the first principal arrives so the values enter at the floor and a
    // newer cloud value wins.
    if (host.isWriter) {
      const done = this.#d.marker.get();
      host.importLocal(
        done ? {} : (config.importable() as Record<string, Json>),
      );
      if (!done) this.#d.marker.set();
    }
    host.resume();
    this.#subject = subject;
    host.machine.signIn(subject);
    await host.touch();
    await this.#chain;
    this.#d.config.noteSyncChange(null, "remote");
  }

  /** The identity session's events drive the machine. */
  identity(note: IdentityNote): Promise<void> {
    const run = this.#work.then(async () => {
      await this.attach();
      const { host } = this.#d;
      if (!host.started) return;
      if (note.kind === "signedOut") await this.#leave();
      else if (note.subject !== this.#subject) await this.#signIn(note.subject);
      host.notePrincipal();
    });
    this.#work = run.catch(() => undefined);
    return run;
  }

  async #signOutNow(): Promise<void> {
    const { host } = this.#d;
    if (host.isWriter) {
      host.machine.signOut();
      await host.flush(SYNC_SIGNOUT_FLUSH_MS);
      await host.touch();
    }
    await this.#chain;
  }

  /** The identity client's pre-sign-out hook: flush (bounded), sign out, forget. */
  async beforeSignOut(): Promise<void> {
    const { host } = this.#d;
    await this.#work;
    if (!host.started || this.#subject === null) return;
    this.#forgot = false;
    try {
      // A follower has nothing to send; the writer is told by the purge that follows.
      if (host.isWriter) {
        host.machine.signOut();
        await host.flush(SYNC_SIGNOUT_FLUSH_MS);
        await host.touch();
      }
    } finally {
      // The machine's own `signedOut` event forgets; if it never came (a failure above, or a
      // follower), forget now.
      await this.#chain;
      await host.forgotten();
      if (!this.#forgot) await this.#forget();
      this.#subject = null;
      this.#d.config.noteSyncChange(null, "remote");
      host.notePrincipal();
    }
  }

  /** The person went (the session ended): leave the principal without a flush. */
  async #leave(): Promise<void> {
    const { host } = this.#d;
    if (this.#subject === null) return;
    if (host.isWriter) {
      host.machine.signOut();
      await host.touch();
    } else {
      this.#subject = null;
    }
    await this.#chain;
    this.#d.config.noteSyncChange(null, "remote");
  }

  // ── The machine's events ─────────────────────────────────────────────────────────────────

  #onEvents(events: SyncEvent[]): void {
    const left = events.some(
      (e) => e.type === "signedOut" && FORGETTING.has(e.reason),
    );
    if (left) this.#forgot = true;
    const offers = events.filter((e) => e.type === "signInOffered");
    for (const e of events) {
      if (e.type === "signedOut") this.#subject = null;
      if (e.type === "change") this.#d.config.noteSyncChange(e.keys, e.origin);
    }
    if (left) this.#d.config.noteSyncChange(null, "remote");
    for (const e of events) {
      // The offer follows the forget, so a person never sees it before their data is gone.
      if (left && e.type === "signInOffered") continue;
      this.#emit(e);
    }
    if (left) {
      this.#chain = this.#chain.then(async () => {
        await this.#d.host.forgotten();
        if (offers.length === 0)
          this.#emit({ type: "signInOffered", signInUrl: null });
        for (const o of offers) this.#emit(o);
      });
    }
  }

  #emit(e: SyncEvent): void {
    for (const fn of this.#listeners) {
      try {
        fn([e]);
      } catch {
        // A listener's failure never reaches the machine.
      }
    }
  }

  /** Drop the ring (the root first), then the synced data. Each step is tried whatever the other
   *  did; a failure is logged and never thrown. */
  async #forget(): Promise<void> {
    this.#forgot = true;
    const ring = this.#d.keyring.forget().catch(() => {
      this.#d.log?.("cloud sync: the key ring pin could not be removed");
    });
    const data = this.#d.host.purge().catch(() => {
      this.#d.log?.("cloud sync: the synced data could not be deleted");
    });
    await Promise.all([ring, data]);
  }

  // ── The config engine's port ─────────────────────────────────────────────────────────────

  #port(): ConfigSyncPort {
    const { host } = this.#d;
    const done = (r: CallResult) => r;
    return {
      active: () => host.started && this.#subject !== null,
      set: async (key, value) => done(await host.set(key, value as Json)),
      clear: async (key) => done(await host.clear(key)),
      get: (key) => {
        const e = host.machine.get(key);
        return { value: e.value as never, from: e.from };
      },
      state: (key) => host.machine.settingState(key).sync,
      keys: () => host.knownKeys(),
    };
  }
}

/** The client app code sees for a started API (`adapter.cloudSync` once loaded). */
export function clientOf(
  api: BrowserCloudSyncApi,
  host: BrowserCloudSyncHost,
): CloudSyncClient {
  return {
    unsupported: null,
    host: async () => host,
    status: () => api.status(),
    flush: () => api.flush(),
    purge: () => host.purge(),
    onEvents: (l) => api.onEvents(l),
    onStatus: (l) => api.onStatus(l),
    attach: () => api.attach(),
    identity: (n) => api.identity(n),
    beforeSignOut: () => api.beforeSignOut(),
  };
}
