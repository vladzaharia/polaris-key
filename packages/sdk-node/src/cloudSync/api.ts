// The Cloud Sync settings API (U-06.3): what app code sees on top of the host (`host.ts`).
//
//   client.cloudSync.status() / flush()      the machine's status, and "send what is waiting"
//   client.events.on("cloudSync", fn)        the machine's events, in order
//   config.set / clear / setting(k).sync()   routed through the machine while a principal is held
//
// The identity session's subject drives the machine: a stored or new subject signs it in, a
// sign-out flushes (bounded) and signs it out. Rules kept here (plans/U-sync-clients-slices.md s9):
//   S6  When the machine leaves a principal (`signOut`, `accountRequired`, `subjectChanged`) the key
//       ring is forgotten in a `finally`: the root goes first, a failure to remove the pin is logged
//       and never replaces the sign-out's own error, and nothing held means nothing to fail. The
//       sign-in offer follows the forget.
//   S6b `account_required` keeps the machine as it stands (blocked, partition gone) instead of
//       rebuilding it empty, and the subject the Worker refused is not signed in again until a
//       sign-out or a different subject. A key-ring or file `account_required` calls
//       `accountRequired()` here, so a device with no `/sync` traffic learns it too. The offered
//       `signInUrl` is vetted (https on the Worker's origin, else null).
//   S7  No event, log line or error here carries a value or the root; events name keys only.
// Licence state is never read or written from this module.

import {
  SYNC_SIGNOUT_FLUSH_MS,
  type CallResult,
  type Json,
  type SyncEvent,
  type SyncStatus,
} from "@polaris-key/client-core/cloud-sync";
import {
  SyncCollection,
  type ConflictListener,
  type MergeRequest,
  mergeStreamEvent,
  mergedStatus,
} from "@polaris-key/client-core/sync";
import { Feature } from "../constants.generated.js";
import type { ConflictStreamEvent } from "../core/events.js";
import type {
  ConfigClient,
  ConfigSyncPort,
  SettingSync,
} from "../config/client.js";
import type { CoreContext } from "../core/context.js";
import type { IdentityEvent } from "../identity/signIn.js";
import type { KeyringClient } from "../keyring/client.js";
import type { CloudSyncHost } from "./host.js";
import { safeSignInUrl } from "@polaris-key/ui-core/browser/sdk/core/signInUrl.js";

/** The reasons the machine leaves a principal, each of which drops the key ring. */
const FORGETTING = new Set(["signOut", "accountRequired", "subjectChanged"]);

export interface CloudSyncApiDeps {
  ctx: CoreContext;
  host: CloudSyncHost;
  keyring: KeyringClient;
  config: ConfigClient;
  /** The persisted subject of the signed-in account, or null. */
  subject: () => Promise<string | null>;
  /** `client.events.safeEmit("cloudSync", …)`. */
  emit: (e: SyncEvent | ConflictStreamEvent) => void;
  /** Diagnostics; never given a value or a secret. */
  log?: (message: string) => void;
  /** Told whenever the person the machine is signed in as changes (null: nobody). */
  onSubject?: (subject: string | null) => void;
  /** Delete the person's save-transfer journal and chunk cache (U-22.5). */
  purgeSaves?: () => Promise<void>;
}

export class CloudSyncApi {
  readonly #d: CloudSyncApiDeps;
  #attached: Promise<void> | null = null;
  #subjectValue: string | null = null;
  /** The person the machine is signed in as; the host is told, so no request outlives them. */
  get #subject(): string | null {
    return this.#subjectValue;
  }
  set #subject(s: string | null) {
    this.#subjectValue = s;
    this.#d.host.bindSubject(s);
    this.#d.onSubject?.(s);
  }
  #forgot = false;
  /** The Worker's origin: the only host a sign-in offer may name. */
  readonly #origin: string;
  #chain: Promise<void> = Promise.resolve();
  /** Identity events, one at a time and in order. */
  #work: Promise<void> = Promise.resolve();

  constructor(deps: CloudSyncApiDeps) {
    this.#d = deps;
    this.#origin = new URL(deps.ctx.baseUrl).origin;
    // `conflictOpened` / `conflictClosed` on the stream come from the registry, which covers the
    // machine's requests and the saves layer's; ids and names only (S7).
    deps.host.merge.onEvent((e) => this.#d.emit(mergeStreamEvent(e)));
  }

  // ── What app code calls ──────────────────────────────────────────────────────────────────

  /** The machine's status. `local` before Cloud Sync has started. Throws the typed `product`
   *  N/A when the product does not run the Sync service. */
  status(): SyncStatus {
    this.#d.ctx.requireService("sync", Feature.syncSettings);
    return mergedStatus(this.#d.host);
  }

  /**
   * Listen for requests as they open (`revision` conflicts the app has not decided). The ones
   * already open are replayed. A listener that returns a choice (`"local"`, `"remote"`, `"both"` or
   * `{ value }`) decides the request at once. Returns the remover.
   */
  onConflict(fn: ConflictListener): () => void {
    this.#d.ctx.requireService("sync", Feature.syncConflict);
    return this.#d.host.merge.onConflict(fn);
  }

  /** The requests open now, in id order. Each holds the device's copy unsent until `keep`. */
  conflicts(): MergeRequest[] {
    this.#d.ctx.requireService("sync", Feature.syncConflict);
    return this.#d.host.merge.conflicts();
  }

  /** Whether the cloud held nothing at the person's first pull: `true`, `false`, or `null` before
   *  any first pull (or with nobody signed in). */
  cloudEmpty(): boolean | null {
    this.#d.ctx.requireService("sync", Feature.syncConflict);
    return this.#d.host.started ? this.#d.host.machine.cloudEmpty() : null;
  }

  /** Send what is waiting now (bounded by the sign-out flush window) and save the journal. */
  async flush(): Promise<SyncStatus> {
    this.#d.ctx.requireService("sync", Feature.syncSettings);
    await this.#attach();
    await this.#work;
    await this.#d.host.flush();
    await this.#chain;
    return this.status();
  }

  /** The records handle of a collection the product's catalog declares (U-46). Starts the host
   *  first; an undeclared name answers `collection_unknown` from each call, never a throw. Throws
   *  the typed `product` N/A when the product does not run the Sync service. */
  async collection(name: string): Promise<SyncCollection> {
    this.#d.ctx.requireService("sync", Feature.syncRecords);
    await this.#attach();
    const host = this.#d.host;
    return new SyncCollection(name, {
      // The machine is rebuilt when the catalog changes, so it is read at each call.
      get machine() {
        host.catchUp();
        return host.machine;
      },
      onEvents: (fn) => host.onEvents(fn),
      touch: () => void host.touch(),
    });
  }

  // ── What the client calls ────────────────────────────────────────────────────────────────

  /** Start the host and sign the machine in as the stored subject. Idempotent; a no-op while the
   *  product does not run the Sync service. */
  attach(): Promise<void> {
    return this.#attach();
  }

  #attach(): Promise<void> {
    if (!this.#d.ctx.enabled("sync")) return Promise.resolve();
    return (this.#attached ??= this.#start().catch((e) => {
      this.#attached = null;
      throw e;
    }));
  }

  async #start(): Promise<void> {
    const { host, config } = this.#d;
    await host.start();
    host.onEvents((events) => this.#onEvents(events));
    config.useSync(this.#port());
    // A journal saved while signed in still names its subject.
    this.#subject = host.machine.persist().subject;
    const subject = await this.#d.subject().catch(() => null);
    if (subject !== null) await this.#signIn(subject);
    else await this.#leave();
  }

  async #signIn(subject: string): Promise<void> {
    const { host, config } = this.#d;
    if (!host.started) return;
    // The Worker took this subject's account away: only a sign-out or another subject lifts it.
    if (subject === host.refused) return;
    // Another person: the first one leaves (unsent edits dropped, then forgotten) before this one
    // starts. The device credential is already the new person's, so nothing is sent for the old one.
    if (this.#subject !== null && this.#subject !== subject)
      await this.#signOutNow();
    // Once per install (the machine ignores a second call), before the first principal arrives so
    // the values enter at the floor and a newer cloud value wins.
    await host.importLocalOnce(config.importable() as Record<string, Json>);
    host.resume();
    this.#subject = subject;
    host.machine.signIn(subject);
    await host.touch();
    await this.#chain;
  }

  /** The identity session's events drive the machine. */
  onIdentity(e: IdentityEvent): Promise<void> {
    const run = this.#work.then(() => this.#onIdentity(e));
    this.#work = run.catch(() => undefined);
    return run;
  }

  async #onIdentity(e: IdentityEvent): Promise<void> {
    await this.#attach();
    const { host } = this.#d;
    if (!host.started) return;
    const subject = e.kind === "signedOut" ? null : e.subject;
    if (subject === null) return this.#leave();
    if (subject !== this.#subject) await this.#signIn(subject);
  }

  /** The person changed: the credential in use is already the new person's, so this never talks
   *  to the server. Unsynced edits are discarded, and the old synced values leave memory before
   *  any await. The only flush is `beforeSignOut`, while the old credential is still current. */
  async #signOutNow(): Promise<void> {
    const { host } = this.#d;
    this.#subject = null;
    host.machine.signOut({ discardUnsynced: true });
    await host.touch();
    await this.#chain;
  }

  /** The identity client's pre-sign-out hook: flush (bounded), sign out, forget. */
  async beforeSignOut(): Promise<void> {
    const { host } = this.#d;
    await this.#work;
    if (!host.started || this.#subject === null) return;
    this.#forgot = false;
    try {
      host.machine.signOut();
      await host.flush(SYNC_SIGNOUT_FLUSH_MS);
      await host.touch();
    } finally {
      // The machine's own `signedOut` event forgets; if it never came (a failure above), forget now.
      await this.#chain;
      if (!this.#forgot) await this.#forget();
      this.#subject = null;
    }
  }

  /** The device was deactivated or the identity forgotten: leave the principal without a flush. */
  async #leave(): Promise<void> {
    const { host } = this.#d;
    // Signed out (or never signed in): what `account_required` refused is not refused any more.
    await host.clearRefused();
    if (this.#subject === null) return;
    host.machine.signOut();
    await host.touch();
    await this.#chain;
  }

  /**
   * A key-ring or file route answered `account_required` (V5 §11.5): the machine takes the same
   * transition as for a `/sync` 403. Never throws into the route that saw it.
   */
  async accountRequired(signInUrl: string | null): Promise<void> {
    await this.#attach().catch(() => undefined);
    this.#d.host.accountRequired(signInUrl);
    await this.#chain;
  }

  /** Called when the licence is deactivated: the principal is gone with the device. */
  async onDeactivated(): Promise<void> {
    await this.#work;
    if (this.#d.host.started) await this.#leave();
    await this.#chain;
    // Deactivation drops the synced data whether or not a principal was held.
    await this.#forget();
    this.#subject = null;
  }

  // ── The machine's events ─────────────────────────────────────────────────────────────────

  #onEvents(events: SyncEvent[]): void {
    const left = events.some(
      (e) => e.type === "signedOut" && FORGETTING.has(e.reason),
    );
    const blocked = events.some(
      (e) => e.type === "signedOut" && e.reason === "accountRequired",
    );
    const was = this.#subject;
    // The root leaves memory before anything else runs (`forget` locks first, synchronously).
    // `account_required` keeps the machine as it stands; every other leave purges it.
    const forgotten = left
      ? this.#forget(blocked ? { subject: was } : null)
      : null;
    const offers = events.filter((e) => e.type === "signInOffered");
    try {
      for (const e of events) {
        // The registry reports these, for both kinds of request (`#onMerge`).
        if (e.type === "conflict" || e.type === "conflictClosed") continue;
        if (e.type === "signedOut") this.#subject = null;
        if (e.type === "change")
          this.#d.config.noteSyncChange(e.keys, e.origin);
        if (left && e.type === "signInOffered") continue;
        this.#emit(e);
      }
    } finally {
      if (forgotten !== null) {
        this.#chain = this.#chain.then(async () => {
          await forgotten;
          if (offers.length === 0)
            this.#emit({ type: "signInOffered", signInUrl: null });
          for (const o of offers) this.#emit(o);
        });
      }
    }
  }

  /** The Worker's sign-in URL goes to the app only if it is a path or on the Worker's own origin. */
  #emit(e: SyncEvent): void {
    this.#d.emit(
      e.type === "signInOffered"
        ? {
            type: "signInOffered",
            signInUrl: safeSignInUrl(e.signInUrl, this.#origin),
          }
        : e,
    );
  }

  /** Drop the ring (the root first), then the synced data on disk and in memory. Each step is
   *  tried whatever the other did; a failure is logged and never thrown. With `blocked` (after
   *  `account_required`) the data is not purged: the machine is saved as it stands. */
  async #forget(
    blocked: { subject: string | null } | null = null,
  ): Promise<void> {
    this.#forgot = true;
    // The root leaves memory first, synchronously (a save codec stops with it); the pin goes last.
    this.#d.keyring.lock();
    // `purge` waits for an in-flight pump, so it runs after the events batch that asked for it.
    const data = (
      blocked === null
        ? this.#d.host.purge()
        : this.#d.host.saveBlocked(blocked.subject)
    ).catch(() => {
      this.#d.log?.("cloud sync: the synced data could not be deleted");
    });
    // The save transfers (journal, chunk cache, running writes) go before the ring is forgotten.
    await (this.#d.purgeSaves?.() ?? Promise.resolve()).catch(() => {
      this.#d.log?.("cloud sync: the save transfers could not be deleted");
    });
    const ring = this.#d.keyring.forget().catch(() => {
      this.#d.log?.("cloud sync: the key ring pin could not be removed");
    });
    await Promise.all([ring, data]);
  }

  // ── The config client's port ─────────────────────────────────────────────────────────────

  #port(): ConfigSyncPort {
    const result = async (r: CallResult) => {
      // The machine queued the edit; one pump reports its events (nothing is due before the
      // debounce, so this does not wait on the network).
      await this.#d.host.touch();
      return r;
    };
    return {
      active: () => this.#d.host.started && this.#subject !== null,
      set: (key, value) => {
        this.#d.host.catchUp();
        return result(this.#d.host.machine.set(key, value as Json));
      },
      clear: (key) => {
        this.#d.host.catchUp();
        return result(this.#d.host.machine.clear(key));
      },
      get: (key) => {
        const e = this.#d.host.machine.get(key);
        return { value: e.value as never, from: e.from };
      },
      state: (key): SettingSync => this.#d.host.machine.settingState(key).sync,
    };
  }
}
