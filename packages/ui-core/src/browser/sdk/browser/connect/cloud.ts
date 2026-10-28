// The browser's Cloud Connect engine (CC-09.2, after sdk-node CC-08.3; plan §3): the relay is the
// only path, because a page cannot discover devices on a LAN or open a socket to one. Loaded on
// the first `cloudConnect.start()`; `index.ts` holds the lean facade.
//
// Rules this module keeps:
//  - the relay carries only mode `a` sessions (see relay.ts). Modes `v` and `p` are not reachable
//    through this API at all;
//  - `open(id)` dials over the relay and nothing else; a failure is never swallowed, the typed
//    `RelayError` or `LanError` is thrown;
//  - a pushed roster or trust manifest is reported as a `ConnectNotice`, stored or refused.

import { stopWithin } from "@polaris-key/client-core/peer";
import type { ConnectClient, ConnectDevice } from "./index.js";
import type { ConnectNotice } from "./channel.js";
import { LanError, RelayError } from "./errors.js";
import { RelayService, type RelayOptions, type RelayStatus } from "./relay.js";
import { serialQueue } from "./redact.js";
import { locks } from "./lock.js";
import type { ConnectSession } from "./session.js";

/** The most a sign-out waits on Connect (decision D-12). */
export const SIGN_OUT_BOUND_MS = 15_000;

export interface CloudConnectOptions {
  /** Options for the relay client (the socket factory, timers, caps, label). */
  relay?: RelayOptions;
}

export interface CloudPeer {
  deviceId: string;
  /** Always false in a browser. */
  lan: boolean;
  /** Online in the relay room right now. */
  relay: boolean;
}

export interface CloudConnectStatus {
  running: boolean;
  /** A browser has no LAN. */
  lan: "off";
  lanError: null;
  /** `elsewhere`: another tab of this app holds the relay socket; this one takes over if it closes. */
  relay: "off" | "elsewhere" | RelayStatus["state"];
  relayError: RelayError | null;
}

export class CloudConnect {
  #relay: RelayService | null = null;
  #self = "";
  #running = false;
  #unsub: (() => void)[] = [];
  #sessions = new Set<ConnectSession>();
  #elsewhere = false;
  #release: (() => void) | null = null;
  #abort: AbortController | null = null;
  /** Replaced by a forced stop, so a stop that never settles cannot block what comes after. */
  #serial = serialQueue();
  /** Bumped by a forced stop, so a `start()` it overtook tears down what it made. */
  #epoch = 0;
  /** The relay a `stop()` in flight is still closing, for the forced stop to reach. */
  #draining: RelayService | null = null;

  constructor(
    private readonly connect: ConnectClient,
    private readonly hooks: {
      /** True when something listens; an inbound session nobody listens to is closed. */
      channel: (s: ConnectSession) => boolean;
      notice: (n: ConnectNotice) => void;
      change: () => void;
    },
  ) {}

  status(): CloudConnectStatus {
    const r = this.#relay?.status ?? null;
    return {
      running: this.#running,
      lan: "off",
      lanError: null,
      relay: r === null ? (this.#elsewhere ? "elsewhere" : "off") : r.state,
      relayError: r?.error ?? null,
    };
  }

  /** Get the identity and connect to the relay. Throws what `connect.identity()` throws
   *  (`no-token`, `connect-unavailable`, `invalid-options`, ...). */
  start(opts: CloudConnectOptions = {}): Promise<void> {
    return this.#serial(async () => {
      if (this.#running) return;
      const epoch = this.#epoch;
      const id = await this.connect.identity();
      if (epoch !== this.#epoch) return;
      this.#self = id.deviceId;
      this.#running = true;
      const lock = locks();
      if (lock === null) this.#startRelay(opts);
      else {
        // One tab holds the socket: the room replaces a device's third socket (4009), so tabs
        // that each opened one would fight. The others report `elsewhere` and wait their turn.
        const key = `pkey-connect-relay:${this.connect.lockName.replace(/^pkey-connect:/, "")}`;
        if (await this.#hold(key, true)) this.#startRelay(opts);
        else {
          this.#elsewhere = true;
          this.#abort = new AbortController();
          void this.#hold(key, false).then((got) => {
            if (!got) return;
            if (!this.#running) {
              this.#release?.();
              return;
            }
            this.#elsewhere = false;
            this.#startRelay(opts);
            this.hooks.change();
          });
        }
      }
      this.hooks.change();
    });
  }

  #startRelay(opts: CloudConnectOptions): void {
    const relay = new RelayService(this.connect.relaySource(), opts.relay);
    this.#relay = relay;
    this.#unsub.push(
      relay.onSession((s) => this.#inbound(s)),
      relay.onNotice((n) => this.hooks.notice(n)),
      relay.onState(() => this.hooks.change()),
      relay.onMembers(() => this.hooks.change()),
    );
    relay.start();
  }

  /** Hold the relay-socket lock until `stop()`. Resolves true once held, false when it is not
   *  available (`ifAvailable`) or the request was aborted. */
  #hold(key: string, ifAvailable: boolean): Promise<boolean> {
    const l = locks()!;
    return new Promise((decide) => {
      const options = ifAvailable
        ? { ifAvailable: true }
        : { signal: this.#abort!.signal };
      l.request(key, options, (lock: unknown) => {
        if (lock === null) {
          decide(false);
          return undefined;
        }
        decide(true);
        return new Promise<void>((release) => {
          this.#release = release;
        });
      }).catch(() => decide(false));
    });
  }

  /** Close the sessions and the relay socket. Safe to call more than once. */
  stop(): Promise<void> {
    return this.#serial(async () => {
      if (!this.#running && this.#relay === null) return;
      const epoch = this.#epoch;
      this.#unlock();
      const relay = this.#relay;
      this.#relay = null;
      this.#draining = relay;
      await Promise.all(
        [...this.#sessions].map((s) => s.close().catch(() => undefined)),
      );
      if (epoch === this.#epoch) this.#sessions.clear();
      await relay?.stop().catch(() => undefined);
      if (epoch === this.#epoch) this.#draining = null;
      this.hooks.change();
    });
  }

  /** Not running any more: release the relay-socket lock and the listeners. */
  #unlock(): void {
    this.#running = false;
    this.#elsewhere = false;
    this.#abort?.abort();
    this.#abort = null;
    this.#release?.();
    this.#release = null;
    for (const u of this.#unsub.splice(0)) u();
  }

  /**
   * The sign-out step (decision D-12): `stop()`, but never past `boundMs` (default 15 s) and never
   * failing. When it is held up, the relay socket is force-cancelled, the held identity is dropped
   * and the sign-out goes on.
   */
  async stopForSignOut(boundMs: number = SIGN_OUT_BOUND_MS): Promise<void> {
    if (!(await stopWithin(() => this.stop(), boundMs))) return;
    this.#epoch++;
    this.#serial = serialQueue();
    this.#unlock();
    const relays = [this.#relay, this.#draining];
    this.#relay = this.#draining = null;
    this.#sessions.clear();
    for (const r of relays) r?.abort();
    this.hooks.change();
  }

  /** The person's other devices online in the relay room right now. */
  peers(): CloudPeer[] {
    const out: CloudPeer[] = [];
    for (const id of this.#relay?.members() ?? [])
      if (id !== this.#self)
        out.push({ deviceId: id, lan: false, relay: true });
    return out;
  }

  /** Ask the room who is online now, so `peers()` includes devices that joined since. */
  async refreshPeers(): Promise<CloudPeer[]> {
    await this.#relay?.refreshMembers();
    return this.peers();
  }

  /** `GET /<p>/connect/devices`: the person's devices, display data only. */
  devices(): Promise<ConnectDevice[]> {
    return this.connect.listDevices();
  }

  /** A session to one of the person's devices over the relay. */
  async open(deviceId: string): Promise<ConnectSession> {
    if (!this.#running || this.#relay === null)
      throw new LanError("not_started", "Cloud Connect is not started.");
    return this.#track(await this.#relay.dial(deviceId));
  }

  #inbound(s: ConnectSession): void {
    this.#track(s);
    // Nothing listens: an inbound session would only sit and fill its queue.
    if (!this.hooks.channel(s)) void s.close().catch(() => undefined);
  }

  #track(s: ConnectSession): ConnectSession {
    this.#sessions.add(s);
    s.onClose(() => this.#sessions.delete(s));
    return s;
  }
}
