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
//   S7  No event, log line or error here carries a value or the root; events name keys only.
// Licence state is never read or written from this module.

import {
  SYNC_SIGNOUT_FLUSH_MS,
  type CallResult,
  type Json,
  type SyncEvent,
  type SyncStatus,
} from "@polaris-key/client-core/cloud-sync";
import { Feature } from "../constants.generated.js";
import type {
  ConfigClient,
  ConfigSyncPort,
  SettingSync,
} from "../config/client.js";
import type { CoreContext } from "../core/context.js";
import type { IdentityEvent } from "../identity/signIn.js";
import type { KeyringClient } from "../keyring/client.js";
import type { CloudSyncHost } from "./host.js";

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
  emit: (e: SyncEvent) => void;
  /** Diagnostics; never given a value or a secret. */
  log?: (message: string) => void;
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
  }
  #forgot = false;
  #chain: Promise<void> = Promise.resolve();
  /** Identity events, one at a time and in order. */
  #work: Promise<void> = Promise.resolve();

  constructor(deps: CloudSyncApiDeps) {
    this.#d = deps;
  }

  // ── What app code calls ──────────────────────────────────────────────────────────────────

  /** The machine's status. `local` before Cloud Sync has started. Throws the typed `product`
   *  N/A when the product does not run the Sync service. */
  status(): SyncStatus {
    this.#d.ctx.requireService("sync", Feature.syncSettings);
    return this.#d.host.started
      ? this.#d.host.machine.status()
      : { state: "local", pending: 0 };
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
    else if (this.#subject !== null) await this.#leave();
  }

  async #signIn(subject: string): Promise<void> {
    const { host, config } = this.#d;
    if (!host.started) return;
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
    if (this.#subject === null) return;
    host.machine.signOut();
    await host.touch();
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
    // The root leaves memory before anything else runs (`forget` locks first, synchronously).
    const forgotten = left ? this.#forget() : null;
    const offers = events.filter((e) => e.type === "signInOffered");
    try {
      for (const e of events) {
        if (e.type === "signedOut") this.#subject = null;
        if (e.type === "change")
          this.#d.config.noteSyncChange(e.keys, e.origin);
        if (left && e.type === "signInOffered") continue;
        this.#d.emit(e);
      }
    } finally {
      if (forgotten !== null) {
        this.#chain = this.#chain.then(async () => {
          await forgotten;
          if (offers.length === 0)
            this.#d.emit({ type: "signInOffered", signInUrl: null });
          for (const o of offers) this.#d.emit(o);
        });
      }
    }
  }

  /** Drop the ring (the root first), then the synced data on disk and in memory. Each step is
   *  tried whatever the other did; a failure is logged and never thrown. */
  async #forget(): Promise<void> {
    this.#forgot = true;
    const ring = this.#d.keyring.forget().catch(() => {
      // The root is already gone (`forget` locks first); only the pin file failed to go.
      this.#d.log?.("cloud sync: the key ring pin could not be removed");
    });
    // `purge` waits for an in-flight pump, so it runs after the events batch that asked for it.
    const data = this.#d.host.purge().catch(() => {
      this.#d.log?.("cloud sync: the synced data could not be deleted");
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
