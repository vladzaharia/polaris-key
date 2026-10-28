// The Cloud Connect API an app calls (CC-08.3; plan §3): `client.cloudConnect`. It is a facade over
// the identity client, the LAN service, the relay and the sessions they open.
//
//   start()      get the identity (making and registering the device keys on first use), listen and
//                browse on the LAN, and connect to the relay unless the host turned it off
//   peers()      the person's other devices that can be reached now, with the paths they have
//   devices()    the person's devices as the Worker lists them (display data)
//   open(id)     a session to one device: LAN first, the relay after a bounded LAN attempt
//   onChannel()  sessions other devices opened to this one, on either path
//   stop()       close the sessions, the relay and the LAN service
//
// Rules this module keeps:
//  - the order is LAN, then relay. The LAN attempt is bounded (`lanAttemptMs`); when it fails or
//    runs out of time and the host did not disable the relay, the relay is tried. A device that
//    was not seen on the LAN goes straight to the relay. `session.path` says which was used;
//  - with the relay disabled (`relay: false` at start, or per call) no relay socket is opened and
//    no ticket is asked for: a device that is not reachable on the LAN stays unreachable;
//  - the relay carries only mode `a` sessions (see relay.ts). Modes `v` and `p` are not reachable
//    through this API at all;
//  - a failure on one path is never swallowed: when no path works the last typed error is thrown
//    (`LanError` or `RelayError`).

import { stopWithin } from "@polaris-key/client-core/peer";
import { serialQueue, type ConnectNotice } from "./channel.js";
import type { ConnectClient, ConnectDevice } from "./client.js";
import type { LanOptions, LanPeer, LanService } from "./lan.js";
import {
  RelayError,
  type RelayOptions,
  type RelayService,
  type RelayStatus,
} from "./relay.js";
import { ConnectSession, LanError } from "./session.js";

export interface CloudConnectOptions {
  /** The LAN half. `false` turns it off. */
  lan?: false | LanOptions;
  /** The relay half. `false` turns it off for this run; options go to the relay client. */
  relay?: false | RelayOptions;
  /** How long a LAN attempt may take before the relay is tried (default 4000 ms). */
  lanAttemptMs?: number;
}

export interface OpenOptions {
  /** Do not fall back to the relay for this call. */
  relay?: boolean;
  lanAttemptMs?: number;
}

export interface CloudPeer {
  deviceId: string;
  /** Seen on this network right now. */
  lan: boolean;
  /** Online in the relay room right now. */
  relay: boolean;
}

export interface CloudConnectStatus {
  running: boolean;
  lan: "off" | "on" | "failed";
  lanError: LanError | Error | null;
  relay: "off" | RelayStatus["state"];
  relayError: RelayError | null;
}

const LAN_ATTEMPT_MS = 4000;
/** The most a sign-out waits on Connect (decision D-12). */
export const SIGN_OUT_BOUND_MS = 15_000;

export class CloudConnect {
  #lan: LanService | null = null;
  #relay: RelayService | null = null;
  #lanFailed: Error | null = null;
  #self = "";
  #running = false;
  #relayOn = false;
  #lanAttemptMs = LAN_ATTEMPT_MS;
  #onChannel = new Set<(s: ConnectSession) => void>();
  #onNotice = new Set<(n: ConnectNotice) => void>();
  #unsub: (() => void)[] = [];
  #sessions = new Set<ConnectSession>();
  /** Replaced by a forced stop, so a stop that never settles cannot block what comes after. */
  #serial = serialQueue();
  /** Bumped by a forced stop, so a `start()` it overtook tears down what it made. */
  #epoch = 0;
  /** What a `stop()` in flight is still closing, for the forced stop to reach. */
  #draining: { lan: LanService | null; relay: RelayService | null } | null =
    null;

  constructor(private readonly connect: ConnectClient) {}

  status(): CloudConnectStatus {
    const r = this.#relay?.status ?? null;
    return {
      running: this.#running,
      lan: this.#lan !== null ? "on" : this.#lanFailed ? "failed" : "off",
      lanError: this.#lanFailed,
      relay: r === null ? "off" : r.state,
      relayError: r?.error ?? null,
    };
  }

  /**
   * Get the identity and bring the transports up. Throws what `connect.identity()` throws
   * (`no-token`, `service-unavailable`, `invalid-options`, …). A LAN service that cannot start is
   * not fatal while the relay is on (`status().lanError` says why); with both off or both
   * failed the LAN error is thrown.
   */
  start(opts: CloudConnectOptions = {}): Promise<void> {
    return this.#serial(async () => {
      if (this.#running) return;
      const epoch = this.#epoch;
      const id = await this.connect.identity();
      if (epoch !== this.#epoch) return;
      this.#self = id.deviceId;
      this.#lanAttemptMs = opts.lanAttemptMs ?? LAN_ATTEMPT_MS;
      this.#relayOn = opts.relay !== false;
      this.#lanFailed = null;
      if (opts.lan !== false) {
        try {
          const lan = await this.connect.lan(opts.lan ?? {});
          if (epoch !== this.#epoch) {
            lan.abort();
            return;
          }
          this.#lan = lan;
          this.#unsub.push(
            lan.onSession((s) => this.#inbound(s)),
            lan.onNotice((n) => this.#notice(n)),
          );
        } catch (e) {
          this.#lanFailed = e instanceof Error ? e : new Error("LAN failed");
          if (!this.#relayOn) throw e;
        }
      }
      if (this.#relayOn) {
        const relay = this.connect.relay(
          opts.relay === false ? {} : opts.relay,
        );
        this.#relay = relay;
        this.#unsub.push(
          relay.onSession((s) => this.#inbound(s)),
          relay.onNotice((n) => this.#notice(n)),
        );
      }
      this.#running = true;
    });
  }

  /** Close the sessions, the relay socket and the LAN service. Safe to call more than once. */
  stop(): Promise<void> {
    return this.#serial(async () => {
      if (!this.#running && this.#lan === null && this.#relay === null) return;
      const epoch = this.#epoch;
      this.#running = false;
      for (const u of this.#unsub.splice(0)) u();
      const lan = this.#lan;
      const relay = this.#relay;
      this.#lan = this.#relay = null;
      this.#draining = { lan, relay };
      await Promise.all(
        [...this.#sessions].map((s) => s.close().catch(() => undefined)),
      );
      if (epoch === this.#epoch) this.#sessions.clear();
      await Promise.all([
        lan?.stop().catch(() => undefined),
        relay?.stop().catch(() => undefined),
      ]);
      if (epoch === this.#epoch) this.#draining = null;
    });
  }

  /**
   * The sign-out step (decision D-12): `stop()`, but never past `boundMs` (default 15 s) and never
   * failing. A host callback or transport that holds the stop up is cut off: the LAN listener,
   * the browse and the relay socket are force-cancelled, the held discovery key is dropped, and
   * the sign-out goes on.
   */
  async stopForSignOut(boundMs: number = SIGN_OUT_BOUND_MS): Promise<void> {
    if (await stopWithin(() => this.stop(), boundMs)) this.#forceStop();
  }

  #forceStop(): void {
    this.#epoch++;
    this.#serial = serialQueue();
    this.#running = false;
    for (const u of this.#unsub.splice(0)) u();
    const held = [{ lan: this.#lan, relay: this.#relay }, this.#draining];
    this.#lan = this.#relay = null;
    this.#draining = null;
    this.#sessions.clear();
    for (const h of held) {
      h?.lan?.abort();
      h?.relay?.abort();
    }
  }

  /** The person's other devices that can be reached now, with the paths each has. */
  peers(): CloudPeer[] {
    const out = new Map<string, CloudPeer>();
    for (const p of this.#lan?.peers() ?? [])
      out.set(p.deviceId, { deviceId: p.deviceId, lan: true, relay: false });
    for (const id of this.#relay?.members() ?? []) {
      if (id === this.#self) continue;
      const have = out.get(id);
      if (have) have.relay = true;
      else out.set(id, { deviceId: id, lan: false, relay: true });
    }
    return [...out.values()];
  }

  /** Ask the relay room who is online now, so `peers()` includes devices that joined since. A
   *  no-op without the relay. */
  async refreshPeers(): Promise<CloudPeer[]> {
    await this.#relay?.refreshMembers();
    return this.peers();
  }

  /** `GET /<p>/connect/devices`: the person's devices, display data only. */
  devices(): Promise<ConnectDevice[]> {
    return this.connect.listDevices();
  }

  /**
   * A session to one of the person's devices. LAN first when the device was seen on the network,
   * the relay after a failed or timed-out LAN attempt (unless disabled). Throws a `LanError` or a
   * `RelayError`; `session.path` tells which path an open session took.
   */
  async open(deviceId: string, o: OpenOptions = {}): Promise<ConnectSession> {
    if (!this.#running)
      throw new LanError("not_started", "Cloud Connect is not started.");
    const relayOk = this.#relay !== null && o.relay !== false;
    let lanError: Error | null = null;
    const peer: LanPeer | undefined = this.#lan
      ?.peers()
      .find((p) => p.deviceId === deviceId);
    if (this.#lan !== null && peer !== undefined) {
      try {
        const s = await this.#bounded(
          this.#lan.connect(peer),
          o.lanAttemptMs ?? this.#lanAttemptMs,
        );
        return this.#track(s);
      } catch (e) {
        if (!relayOk) throw e;
        lanError = e instanceof Error ? e : null;
      }
    }
    if (!relayOk) {
      throw (
        lanError ??
        (this.#relay === null || o.relay === false
          ? new LanError(
              "unknown_peer",
              "That device was not found on this network, and the relay is off.",
            )
          : new RelayError("not_connected", "The relay is not connected."))
      );
    }
    return this.#track(await this.#relay!.dial(deviceId));
  }

  /** Called with each session another device opened to this one, on either path. */
  onChannel(fn: (s: ConnectSession) => void): () => void {
    this.#onChannel.add(fn);
    return () => this.#onChannel.delete(fn);
  }

  /** Called when a roster or trust manifest a peer pushed is stored, applied or refused. */
  onNotice(fn: (n: ConnectNotice) => void): () => void {
    this.#onNotice.add(fn);
    return () => this.#onNotice.delete(fn);
  }

  #inbound(s: ConnectSession): void {
    this.#track(s);
    for (const f of [...this.#onChannel]) f(s);
  }

  #notice(n: ConnectNotice): void {
    for (const f of [...this.#onNotice]) f(n);
  }

  #track(s: ConnectSession): ConnectSession {
    this.#sessions.add(s);
    s.onClose(() => this.#sessions.delete(s));
    return s;
  }

  /** Wait for a LAN attempt at most `ms`; one that finishes late is closed. */
  #bounded(p: Promise<ConnectSession>, ms: number): Promise<ConnectSession> {
    return new Promise((resolve, reject) => {
      let late = false;
      const t = setTimeout(() => {
        late = true;
        reject(
          new LanError(
            "connect_failed",
            "The LAN attempt took too long; trying the relay.",
          ),
        );
      }, ms);
      p.then(
        (s) => {
          clearTimeout(t);
          if (late) void s.close().catch(() => undefined);
          else resolve(s);
        },
        (e: unknown) => {
          clearTimeout(t);
          if (!late) reject(e);
        },
      );
    });
  }
}
