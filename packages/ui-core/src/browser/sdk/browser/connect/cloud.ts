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

import type { ConnectClient, ConnectDevice } from "./index.js";
import type { ConnectNotice } from "./channel.js";
import { LanError, RelayError } from "./errors.js";
import { RelayService, type RelayOptions, type RelayStatus } from "./relay.js";
import { serialQueue } from "./redact.js";
import type { ConnectSession } from "./session.js";

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
  relay: "off" | RelayStatus["state"];
  relayError: RelayError | null;
}

export class CloudConnect {
  #relay: RelayService | null = null;
  #self = "";
  #running = false;
  #unsub: (() => void)[] = [];
  #sessions = new Set<ConnectSession>();
  readonly #serial = serialQueue();

  constructor(
    private readonly connect: ConnectClient,
    private readonly hooks: {
      channel: (s: ConnectSession) => void;
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
      relay: r === null ? "off" : r.state,
      relayError: r?.error ?? null,
    };
  }

  /** Get the identity and connect to the relay. Throws what `connect.identity()` throws
   *  (`no-token`, `connect-unavailable`, `invalid-options`, ...). */
  start(opts: CloudConnectOptions = {}): Promise<void> {
    return this.#serial(async () => {
      if (this.#running) return;
      const id = await this.connect.identity();
      this.#self = id.deviceId;
      const relay = new RelayService(this.connect.relaySource(), opts.relay);
      this.#relay = relay;
      this.#unsub.push(
        relay.onSession((s) => this.#inbound(s)),
        relay.onNotice((n) => this.hooks.notice(n)),
        relay.onState(() => this.hooks.change()),
        relay.onMembers(() => this.hooks.change()),
      );
      relay.start();
      this.#running = true;
      this.hooks.change();
    });
  }

  /** Close the sessions and the relay socket. Safe to call more than once. */
  stop(): Promise<void> {
    return this.#serial(async () => {
      if (!this.#running && this.#relay === null) return;
      this.#running = false;
      for (const u of this.#unsub.splice(0)) u();
      const relay = this.#relay;
      this.#relay = null;
      await Promise.all(
        [...this.#sessions].map((s) => s.close().catch(() => undefined)),
      );
      this.#sessions.clear();
      await relay?.stop().catch(() => undefined);
      this.hooks.change();
    });
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
    this.hooks.channel(s);
  }

  #track(s: ConnectSession): ConnectSession {
    this.#sessions.add(s);
    s.onClose(() => this.#sessions.delete(s));
    return s;
  }
}
