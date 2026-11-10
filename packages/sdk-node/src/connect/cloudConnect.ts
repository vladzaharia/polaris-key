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
//   nearby       approval of a device with no sign-in by a signed-in device nearby (mode v, CC-15):
//                `request()` on the new device, `onRequest()` on the approver
//   links        inter-account links (mode p pairing, mode c sessions, CC-19): `pair()`, `list()`,
//                `remove()`, `open()`, `onLink()`; off unless discovery says `interAccount`
//   localLinks   local links (CC-29): `pair()` and `join()` with a code, `list()`, `rename()`,
//                `remove()`, `setReachable()`, `open()`, `onLink()`; off unless discovery says
//                `localPairing`, and needing no account
//
// Rules this module keeps:
//  - the order is LAN, then relay. The LAN attempt is bounded (`lanAttemptMs`); when it fails or
//    runs out of time and the host did not disable the relay, the relay is tried. A device that
//    was not seen on the LAN goes straight to the relay. `session.path` says which was used;
//  - with the relay disabled (`relay: false` at start, or per call) no relay socket is opened and
//    no ticket is asked for: a device that is not reachable on the LAN stays unreachable;
//  - the account relay carries only mode `a` sessions (see relay.ts). Modes `v` and `p` are not
//    reachable through this API at all, and mode `c` runs over contact rooms (contactRelay.ts)
//    that only `links` opens;
//  - with no account, `start()` brings up the LAN service for the local links alone when discovery
//    says `localPairing` (§15.5, "A host that holds only local links runs the listener with no
//    account at all"); a sign-out takes the account half away and, when links are reachable,
//    brings that service back up (§15.12, "Forget and accounts");
//  - a failure on one path is never swallowed: when no path works the last typed error is thrown
//    (`LanError` or `RelayError`).

import {
  PolarisError,
  UnsupportedError,
  type DeviceKeyPort,
} from "@polaris-key/client-core";
import { stopWithin, type Ring } from "@polaris-key/client-core/peer";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { ErrorCode, Feature } from "../constants.generated.js";
import type { IdentityFragment } from "../discovery.js";
import { serialQueue, type ConnectNotice } from "./channel.js";
import type { ConnectClient, ConnectDevice } from "./client.js";
import { ContactRelay } from "./contactRelay.js";
import { CloudLinks } from "./links.js";
import { LocalLinks } from "./localLinks.js";
import { contactId } from "./contacts.js";
import { CloudTransfer } from "./transfer.js";
import { PartialStore } from "./transferStore.js";
import type { LanOptions, LanPeer, LanService } from "./lan.js";
import { MdnsUnavailableError } from "./mdns.js";
import {
  NearbyApprover,
  type NearbyApproval,
  type NearbyApproverHandle,
  type NearbyApproverOptions,
} from "./nearbyApprover.js";
import {
  NearbyRequester,
  type NearbyRequest,
  type NearbyRequestOptions,
} from "./nearbyRequester.js";
import {
  RelayError,
  type RelayOptions,
  type RelayService,
  type RelayStatus,
} from "./relay.js";
import { ConnectSession, LanError } from "./session.js";

/** What nearby approval reads of the client (CC-15.N4). */
export interface NearbyDeps {
  slug: string;
  /** Seconds since the epoch. */
  now(): number;
  /** The Identity service is on for this product, else the typed N/A. */
  requireIdentity(): void;
  /** The Identity fragment of discovery; `fresh` loads it again first. Null while it is off. */
  identity(fresh: boolean): Promise<IdentityFragment | null>;
  /** This device is signed in on the product. */
  signedIn(): Promise<boolean>;
  /** D's device keys and its `X-PKey-Device` value. */
  signer(): Promise<{ port: DeviceKeyPort; deviceId: string }>;
}

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

const unsupported = (
  detail: string,
  reason: "product" | "dependency" | "runtime",
): UnsupportedError =>
  new UnsupportedError(
    { supported: false, feature: Feature.identityNearby, reason, detail },
    reason === "product"
      ? ErrorCode.serviceUnavailable
      : ErrorCode.nearbyUnsupported,
  );

/**
 * Nearby approval (CC-15; WIRE-CONTRACT-V5 §15.6.1), `client.cloudConnect.nearby`. It is gated by
 * the Identity service's discovery (`nearby` and its endpoints), never by Connect: it works with
 * Connect off. It carries the vouch over the LAN and calls no route; the host calls
 * `nearby/start`, `poll` and `approve` and gives the answers to the handles.
 */
export class CloudNearby {
  readonly #approvers = new Set<NearbyApprover>();
  readonly #requests = new Set<NearbyRequester>();
  /** Bumped by every `stopAll`: a start that began before it must not outlive it. */
  #epoch = 0;

  constructor(private readonly deps: NearbyDeps | null) {}

  async #fragment(
    fresh: boolean,
    endpoints: readonly ("nearbyStart" | "nearbyPoll" | "nearbyApprove")[],
  ): Promise<IdentityFragment> {
    const d = this.deps;
    if (d === null)
      throw unsupported(
        "Nearby approval is not set up on this client.",
        "runtime",
      );
    // Discovery first: the service table comes from it once it is loaded.
    const f = await d.identity(fresh);
    d.requireIdentity();
    const ep = (f?.endpoints ?? {}) as Record<string, string | undefined>;
    if (f === null || f.nearby !== true || endpoints.some((k) => !ep[k]))
      throw unsupported(
        "This product's discovery does not name nearby approval.",
        "product",
      );
    return f;
  }

  /** The multicast-dns dependency is optional: its absence is the typed `nearby-unsupported`. */
  static #wrap(e: unknown): never {
    if (e instanceof MdnsUnavailableError)
      throw unsupported(e.message, "dependency");
    throw e;
  }

  /**
   * D, the device with no sign-in: browse for approvers nearby and list them for the person to tap
   * (`choose`). `request` is the handle `nearby/start` answered. Throws the typed N/A when the
   * product serves no nearby approval or this runtime cannot browse, and a closed error when a
   * sign-out (`stopAll`) landed while it was starting.
   */
  async request(o: NearbyRequestOptions): Promise<NearbyRequest> {
    const epoch = this.#epoch;
    await this.#fragment(true, ["nearbyStart", "nearbyPoll"]);
    const d = this.deps!;
    for (const r of this.#requests) if (r.closed) this.#requests.delete(r);
    if (epoch !== this.#epoch)
      throw new LanError("closed", "Nearby approval was stopped.");
    let r: NearbyRequester;
    try {
      r = await NearbyRequester.start(
        { slug: d.slug, now: () => d.now(), signer: () => d.signer() },
        o,
      );
    } catch (e) {
      return CloudNearby.#wrap(e);
    }
    if (epoch !== this.#epoch) {
      await r.close().catch(() => undefined);
      throw new LanError("closed", "Nearby approval was stopped.");
    }
    this.#requests.add(r);
    return r;
  }

  /**
   * M, a signed-in device: advertise while the person has "Approve a nearby device" open
   * (`prompt: true`) or has allowed background approval with the permission granted
   * (`prompt: false` with `background: true`), and hand each session that reaches the code to
   * `handler`. Returns the handle that stops, pauses and resumes it. Throws `account_required`
   * when the device is signed out (also when the sign-out landed while this was starting), and the
   * typed N/A when the product serves no nearby approval.
   */
  async onRequest(
    handler: (a: NearbyApproval) => void,
    o: NearbyApproverOptions,
  ): Promise<NearbyApproverHandle> {
    const epoch = this.#epoch;
    await this.#fragment(true, ["nearbyApprove"]);
    const d = this.deps!;
    const signedOut = (): PolarisError =>
      new PolarisError(
        ErrorCode.accountRequired,
        "Sign in before approving a nearby device.",
      );
    if (!(await d.signedIn()) || epoch !== this.#epoch) throw signedOut();
    let h: NearbyApprover;
    try {
      h = await NearbyApprover.start(
        {
          slug: d.slug,
          now: () => d.now(),
          signedIn: () => d.signedIn(),
          nearbyServed: () =>
            this.#fragment(true, ["nearbyApprove"]).then(
              () => true,
              () => false,
            ),
        },
        handler,
        o,
      );
    } catch (e) {
      return CloudNearby.#wrap(e);
    }
    // The sign-out may have landed while the advert was starting, before the handle was kept.
    if (!(await d.signedIn().catch(() => false)) || epoch !== this.#epoch) {
      await h.stop().catch(() => undefined);
      throw signedOut();
    }
    this.#approvers.add(h);
    return {
      stop: async () => {
        this.#approvers.delete(h);
        await h.stop();
      },
      pause: () => h.pause(),
      resume: () => h.resume(),
      setPrompt: (open) => h.setPrompt(open),
      reopen: () => h.reopen(),
      status: () => h.status(),
    };
  }

  /** Stop every advert and close every request. The sign-out step; also `client.close()`. */
  async stopAll(): Promise<void> {
    this.#epoch++;
    const hs = [...this.#approvers];
    const rs = [...this.#requests];
    await Promise.all([
      ...hs.map((h) => h.stop().catch(() => undefined)),
      ...rs.map((r) => r.close().catch(() => undefined)),
    ]);
    for (const h of hs) this.#approvers.delete(h);
    for (const r of rs) this.#requests.delete(r);
  }

  /** The sign-out bound ran out: drop every socket and listener now, with no goodbye. */
  forceStop(): void {
    this.#epoch++;
    for (const h of this.#approvers) h.destroy();
    for (const r of this.#requests) r.destroy();
    this.#approvers.clear();
    this.#requests.clear();
  }
}

export class CloudConnect {
  #lan: LanService | null = null;
  #relay: RelayService | null = null;
  #lanFailed: Error | null = null;
  #self = "";
  #running = false;
  /** The running LAN service has no account half (it serves local links alone). */
  #localOnly = false;
  /** What a sign-out starts the local-only service with; null when the host did not start Connect. */
  #resumeWith: CloudConnectOptions | null = null;
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
  #draining: {
    lan: LanService | null;
    relay: RelayService | null;
    contactRelay: ContactRelay | null;
  } | null = null;

  readonly #nearby: CloudNearby;
  readonly #links: CloudLinks;
  readonly #localLinks: LocalLinks;
  readonly #transfer: CloudTransfer;
  #contactRelay: ContactRelay | null = null;
  /** The local-only service's watch on the link list (set while it runs). */
  #unLocal: (() => void) | null = null;

  constructor(
    private readonly connect: ConnectClient,
    nearby: NearbyDeps | null = null,
    /** Where partial files of received transfers are kept (`<state>/transfer`); null for none. */
    transferDir: string | null = null,
  ) {
    this.#nearby = new CloudNearby(nearby);
    // A roster this device stores re-admits every open session (§15.6).
    connect.onRoster((ring) => this.#readmit(ring));
    this.#transfer = new CloudTransfer({
      store: transferDir === null ? null : new PartialStore(transferDir),
      openDevice: (id) => this.open(id),
      openLink: async (id) =>
        (await this.#localLinks.has(id))
          ? this.#localLinks.open(id)
          : this.#links.open(id),
      hasLink: async (id) =>
        (await connect.contactRows()).some(
          (r) => contactId(r.agreeKey) === id,
        ) || (await this.#localLinks.has(id)),
    });
    this.#localLinks = new LocalLinks(connect.localSource(), {
      adopt: (s) => this.#transfer.adopt(s),
      removed: (keys) =>
        Promise.all(keys.map((k) => this.#transfer.purgePeer(k))).then(
          () => undefined,
        ),
    });
    this.#links = new CloudLinks(connect, {
      adopt: (s) => this.#transfer.adopt(s),
      removed: (keys) =>
        Promise.all(keys.map((k) => this.#transfer.purgePeer(k))).then(
          () => undefined,
        ),
    });
  }

  /** Direct Transfer (CC-20.3): `send(peer, source)`, `onOffer(handler)`, `onResult(fn)`. */
  get transfer(): CloudTransfer {
    return this.#transfer;
  }

  /**
   * Local links (CC-29): pair with a code with no account (`pair`, `join`), then `list`, `rename`,
   * `remove`, `setReachable`, `open` and `onLink`; off unless discovery says `localPairing`. It
   * needs no sign-in; the later sessions (`open`, `onLink`, the adverts) run while `start()` does.
   */
  get localLinks(): LocalLinks {
    return this.#localLinks;
  }

  /** Inter-account links (CC-19): `pair`, `list`, `remove`, `setReachable`, `open`, `onLink`. */
  get links(): CloudLinks {
    return this.#links;
  }

  /**
   * Admit each open session again against a roster this device has just stored: a peer the roster
   * no longer lists with the key the session was admitted under is closed `peer_revoked`. A
   * roster that only adds devices keeps every session.
   */
  #readmit(ring: Ring): void {
    for (const s of [...this.#sessions]) {
      const key =
        s.peerStatic === null ? null : base64UrlEncodeBytes(s.peerStatic);
      const listed = ring.devices.some(
        (d) =>
          d.deviceId === s.peerDeviceId && (key === null || d.agreeKey === key),
      );
      if (!listed) void s.revoke().catch(() => undefined);
    }
  }

  /** Nearby approval (CC-15): `request()` on the new device, `onRequest()` on the approver. */
  get nearby(): CloudNearby {
    return this.#nearby;
  }

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
      if (this.#running && !this.#localOnly) return;
      // A local-only service gives way to the full one.
      if (this.#running) await this.#stopNow();
      const epoch = this.#epoch;
      let id: { deviceId: string } | null = null;
      try {
        id = await this.connect.identity();
      } catch (e) {
        if (!this.#noAccount(e, opts)) throw e;
      }
      if (epoch !== this.#epoch) return;
      if (id === null) return this.#startLocalOnly(opts, epoch);
      this.#self = id.deviceId;
      this.#resumeWith = opts;
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
      // The contact rooms (§15.7) and the links API ride the same transports. A device with no
      // links keeps no room; the list is read again whenever it changes.
      let contactRelay: ContactRelay | null = null;
      if (this.#relayOn) {
        contactRelay = new ContactRelay(
          this.connect.contactRelaySource(),
          opts.relay === false ? {} : opts.relay,
        );
        this.#contactRelay = contactRelay;
        await contactRelay.start().catch(() => undefined);
      }
      this.#links.attach(this.#lan, contactRelay, {
        lanAttemptMs: this.#lanAttemptMs,
        relayOn: this.#relayOn,
      });
      if (this.#lan !== null) await this.#localLinks.attach(this.#lan);
      this.#localOnly = false;
      this.#running = true;
    });
  }

  /**
   * A start that found no account (no token, or no sign-in): with `localPairing` cached on and the
   * LAN not turned off it serves local links alone; any other failure is the caller's.
   */
  #noAccount(e: unknown, opts: CloudConnectOptions): boolean {
    return (
      e instanceof PolarisError &&
      (e.code === ErrorCode.noToken || e.code === ErrorCode.accountRequired) &&
      opts.lan !== false &&
      this.connect.localPairing()
    );
  }

  /**
   * The local-only service (§15.5, §15.12): no account half, the local links alone. A device that
   * holds no link binds no listener (nothing to find, nothing to scan): it waits, and the first
   * link (`pair`, `join`) brings the listener up and the last one forgotten takes it down.
   */
  async #startLocalOnly(
    opts: CloudConnectOptions,
    epoch: number,
  ): Promise<void> {
    this.#self = "";
    this.#resumeWith = opts;
    this.#relayOn = false;
    this.#lanFailed = null;
    this.#localOnly = true;
    this.#running = true;
    this.#unLocal ??= this.connect.localSource().onChange(() => {
      void this.#syncLocalListener().catch(() => undefined);
    });
    try {
      await this.#syncLocalNow(epoch);
    } catch (e) {
      this.#localOnly = false;
      this.#running = false;
      this.#unLocal?.();
      this.#unLocal = null;
      throw e;
    }
  }

  /** Bring the local-only listener to match whether a link is held. */
  async #syncLocalNow(epoch: number): Promise<void> {
    if (!this.#localOnly || epoch !== this.#epoch) return;
    const held = await this.connect
      .localStore()
      .count()
      .catch(() => 0);
    if (held === 0) {
      const lan = this.#lan;
      if (lan === null) return;
      // The last link is gone: the listener closes (the sessions of that link already ended).
      this.#lan = null;
      await this.#localLinks.detach();
      await lan.stop().catch(() => undefined);
      return;
    }
    if (this.#lan !== null) return;
    let lan: LanService;
    try {
      lan = await this.connect.lanLocal(
        this.#resumeWith?.lan === false ? {} : (this.#resumeWith?.lan ?? {}),
      );
    } catch (e) {
      this.#lanFailed = e instanceof Error ? e : new Error("LAN failed");
      throw e;
    }
    if (epoch !== this.#epoch || !this.#localOnly || this.#lan !== null) {
      lan.abort();
      return;
    }
    this.#lan = lan;
    await this.#localLinks.attach(lan);
  }

  /** A link was added or forgotten (or the gate moved) while only local links are served. */
  #syncLocalListener(): Promise<void> {
    const epoch = this.#epoch;
    return this.#serial(() => this.#syncLocalNow(epoch));
  }

  /** Close the sessions, the relay socket and the LAN service. Safe to call more than once. */
  stop(): Promise<void> {
    this.#resumeWith = null;
    return this.#stopSerial();
  }

  #stopSerial(): Promise<void> {
    return this.#serial(() => this.#stopNow());
  }

  async #stopNow(): Promise<void> {
    if (!this.#running && this.#lan === null && this.#relay === null) return;
    const epoch = this.#epoch;
    this.#running = false;
    this.#localOnly = false;
    this.#unLocal?.();
    this.#unLocal = null;
    for (const u of this.#unsub.splice(0)) u();
    const lan = this.#lan;
    const relay = this.#relay;
    const contactRelay = this.#contactRelay;
    this.#lan = this.#relay = this.#contactRelay = null;
    this.#draining = { lan, relay, contactRelay };
    await this.#links.detach();
    await this.#localLinks.detach();
    await Promise.all(
      [...this.#sessions].map((s) => s.close().catch(() => undefined)),
    );
    if (epoch === this.#epoch) this.#sessions.clear();
    await Promise.all([
      lan?.stop().catch(() => undefined),
      relay?.stop().catch(() => undefined),
      contactRelay?.stop().catch(() => undefined),
    ]);
    if (epoch === this.#epoch) this.#draining = null;
  }

  /**
   * The sign-out step (decision D-12): `stop()`, but never past `boundMs` (default 15 s) and never
   * failing. A host callback or transport that holds the stop up is cut off: the LAN listener,
   * the browse and the relay socket are force-cancelled, the held discovery key is dropped, and
   * the sign-out goes on.
   */
  async stopForSignOut(boundMs: number = SIGN_OUT_BOUND_MS): Promise<void> {
    if (await stopWithin(() => this.#stopSerial(), boundMs)) this.#forceStop();
    // The partial files of received transfers go with the session (they are the peer's bytes).
    await stopWithin(() => this.#transfer.purge(), boundMs);
    // Then the nearby adverts and sessions (after Connect, before the device leaves it).
    if (await stopWithin(() => this.#nearby.stopAll(), boundMs))
      this.#nearby.forceStop();
    // Local links are not account data: the LAN service comes back up without the account half
    // when links are reachable (§15.12, "Forget and accounts").
    await stopWithin(() => this.#resumeLocal(), boundMs);
  }

  #resumeLocal(): Promise<void> {
    return this.#serial(async () => {
      const opts = this.#resumeWith;
      if (this.#running || opts === null || !this.connect.localPairing())
        return;
      const rows = await this.connect
        .localStore()
        .rows()
        .catch(() => []);
      if (!rows.some((r) => r.reachable)) return;
      await this.#startLocalOnly(opts, this.#epoch).catch(() => undefined);
    });
  }

  #forceStop(): void {
    this.#epoch++;
    this.#serial = serialQueue();
    this.#running = false;
    this.#localOnly = false;
    this.#unLocal?.();
    this.#unLocal = null;
    for (const u of this.#unsub.splice(0)) u();
    const held = [
      {
        lan: this.#lan,
        relay: this.#relay,
        contactRelay: this.#contactRelay,
      },
      this.#draining,
    ];
    this.#lan = this.#relay = this.#contactRelay = null;
    this.#draining = null;
    this.#sessions.clear();
    void this.#links.detach().catch(() => undefined);
    void this.#localLinks.detach().catch(() => undefined);
    for (const h of held) {
      h?.lan?.abort();
      h?.relay?.abort();
      h?.contactRelay?.abort();
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
    this.#transfer.adopt(s);
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
