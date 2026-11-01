// The LAN half of Cloud Connect (CC-08.2; WIRE-CONTRACT-V5 §15.4 to §15.6): advertise this device
// under the account instance name, browse for the person's other devices, listen on TCP and dial.
//
// Rules this module keeps:
//  - the advert is `p1-` + HMAC(K_disc, epoch, deviceId) with `v=1`, `m=a` and nothing else; it
//    is renewed at every 15-minute epoch boundary and only ever uses the newest K_disc;
//  - a browse hit is kept only if it matches a roster device (never this one) under the current
//    or previous epoch and either delivered key; everything else is dropped and not retried. The
//    mDNS adapter is given the same names up front (`accept`), so a name no roster device can
//    announce never takes a place in its tables;
//  - the listener starts a handshake only when this device holds a verified identity. The
//    handshake (XXpsk0) and admission (certificate, ring, expiry, revocation) run in client-core;
//    a failed tag closes the socket without a word;
//  - unauthenticated sockets are bounded in number, per address, per group and in time; an accepted
//    socket is judged (client-core's `lanVerdict` on its own addresses) before it is read, and one
//    that fails is closed at once (the shared gate, lanGate.ts);
//  - one TCP port serves both families: a dual-stack `::` listener, falling back to 0.0.0.0;
//    a device with several learned addresses dials them in a race (dial.ts), and when the
//    handshake with the winner fails it races the addresses that are left;
//  - the device's X25519 private key never leaves the `DeviceKeyPort`: Noise is given a handle
//    whose static-key operations call `port.dh`.

import type { Server, Socket } from "node:net";
import type { TrustSet } from "@polaris-key/jws";
import {
  accountInstance,
  advertEpoch,
  ADVERT_EPOCH_SECONDS,
  browseAccountInstance,
  browseContactInstance,
  contactInstance,
  HandshakeLimiter,
  MAX_LIVE_CONTACT_ADVERTS,
  parseContactTxt,
  parseTxt,
  type ContactLink,
} from "@polaris-key/client-core/peer";
import {
  refOf,
  wipeLive,
  type ContactRef,
  type LiveContact,
} from "./contacts.js";
import { printAs } from "../core/redact.js";
import {
  PeerDocs,
  channelBase,
  contactChannel,
  defaultTimer,
  type ConnectNotice,
  type RingAdoption,
  type TrustApplication,
} from "./channel.js";
import { dialRaceTo } from "./dial.js";
import { AcceptGate, listenTcp, textVerdict } from "./lanGate.js";
import {
  MulticastDnsAdapter,
  type MdnsAdapter,
  type MdnsFound,
  type MdnsHandle,
} from "./mdns.js";
import { ConnectSession, LanError, SocketLink } from "./session.js";

/** What the LAN service needs of the held identity, read when used. */
export interface LanIdentity {
  slug: string;
  trust: TrustSet;
  sub: string;
  deviceId: string;
  certJws: string;
  certExpiresAt: number;
  ringJws: string;
  ringEpoch: number;
  /** Every roster device id, this one included. */
  roster: string[];
  /** K_disc, newest first. */
  keys: { current: Uint8Array; previous: Uint8Array | null };
  /** The device's X25519 public key. */
  agreePublic: Uint8Array;
  /** X25519 with the device's private key; the key itself is not reachable. */
  dh: (peerPublic: Uint8Array) => Promise<Uint8Array | null>;
}

export interface LanSource {
  load(): Promise<LanIdentity>;
  /** Seconds since the epoch. */
  now(): number;
  /** Monotonic seconds, for rate rules a wall clock set back must not hold off. Default `performance.now()`. */
  mono?(): number;
  /** Ask the Worker for a newer roster (a peer is on a newer one). Best effort. */
  refresh?(): Promise<void>;
  /** Verify and store a roster a peer pushed (the same replacement rules as the identity fetch). */
  adoptRing?(jws: string): Promise<RingAdoption>;
  /** Verify against the usable pins and apply a trust manifest a peer pushed. */
  applyTrust?(jws: string): Promise<TrustApplication>;
  /**
   * The inter-account links (§15.10) in trial order, secrets decoded: empty while links are off
   * (no cached `interAccount`) or none are held. The service wipes what it replaces.
   */
  contacts?(): Promise<LiveContact[]>;
  /** Called when the contacts changed (stored, promoted, removed, re-marked, or the gate moved). */
  onContacts?(fn: () => void): () => void;
  /** A session opened under a contact: the first handshake of a pending one promotes it. */
  contactEstablished?(ref: ContactRef): Promise<void>;
}

export interface LanOptions {
  mdns?: MdnsAdapter;
  /** Where to listen. Default `::` (both families on one port), or 0.0.0.0 where IPv6 is unavailable. */
  host?: string;
  /** Default 0: a random port each listen (§15.4). */
  port?: number;
  /** Capabilities offered. Default `app/1`. */
  caps?: readonly string[];
  label?: string;
  /** Advertise, browse. Both on by default. */
  advertise?: boolean;
  browse?: boolean;
  /** Accept loopback peers. For tests and same-host use only. */
  allowLoopback?: boolean;
  /** Unauthenticated sockets at once (default 32) and per source address (default 4). */
  maxPending?: number;
  maxPendingPerAddress?: number;
  /** Unauthenticated sockets from one group: a link, an IPv4 /24 or an IPv6 /64 (default 16). */
  maxPendingPer64?: number;
  /** Open sessions at once (default 64). */
  maxSessions?: number;
  rekeyMessages?: number;
  rekeySeconds?: number;
  handshakeMs?: number;
  /** Schedule `fn` after `ms`; returns the cancel. Default `setTimeout`, unref'd. */
  timer?: (fn: () => void, ms: number) => () => void;
}

export interface LanPeer {
  deviceId: string;
  /** The first learned address. */
  host: string;
  /** Every learned address (at most four), first seen first; a link-local one carries its `%zone`. */
  hosts?: readonly string[];
  port: number;
}

const IDENTITY_TTL_S = 30;
const CERT_MARGIN_S = 60;
const MISS_CACHE = 1024;

export class LanService {
  #server: Server | null = null;
  #port = 0;
  #mdns: MdnsAdapter;
  #adv: MdnsHandle | null = null;
  #advName = "";
  #browse: MdnsHandle | null = null;
  #cancelEpoch: (() => void) | null = null;
  #id: { at: number; v: LanIdentity } | null = null;
  /** The instance names the roster can announce now (both delivered keys, this and the last epoch). */
  #names = new Set<string>();
  #namesSig = "";
  #namesEpoch = -1;
  #namesBusy = false;
  #peers = new Map<string, LanPeer & { instance: string }>();
  #miss = new Map<string, number>();
  #gate: AcceptGate;
  #links = new Set<SocketLink>();
  /** For a handshake still running: the contacts (id and secret tag) its trial list holds. */
  #serves = new Map<SocketLink, Set<string>>();
  #sessions = new Set<ConnectSession>();
  #onSession = new Set<(s: ConnectSession) => void>();
  #onPeer = new Set<(p: LanPeer) => void>();
  #stopped = false;
  #docs: PeerDocs;
  #queue: Promise<unknown> = Promise.resolve();
  /** The inter-account links held now (empty while off), in trial order. */
  #contacts: LiveContact[] = [];
  #contactsSig = "";
  /** One live contact advert per name; at most `MAX_LIVE_CONTACT_ADVERTS`. */
  #contactAdv = new Map<string, MdnsHandle>();
  #contactPeers = new Map<
    string,
    {
      id: string;
      pending: boolean;
      instance: string;
      hosts: string[];
      port: number;
    }
  >();
  #onContactSession = new Set<(s: ConnectSession) => void>();
  #unContacts: (() => void) | null = null;
  /** One limiter per listener for the contact trial (§15.10, "Admission"). */
  readonly #limiter = new HandshakeLimiter(
    5,
    4,
    () => performance.now() / 1000,
  );

  readonly #src: LanSource;
  readonly #o: LanOptions;

  private constructor(src: LanSource, o: LanOptions) {
    this.#src = src;
    this.#o = o;
    this.#gate = new AcceptGate(o);
    this.#docs = new PeerDocs(src, () => {
      this.#id = null;
      // A new K_disc changes the advert name inside the epoch.
      if (!this.#stopped && this.#adv !== null)
        void this.#rotate().catch(() => undefined);
    });
    printAs(this, () => ({ service: "LanService", port: this.#port }));
    this.#mdns =
      o.mdns ?? new MulticastDnsAdapter({ allowLoopback: o.allowLoopback });
  }

  /** Listen, then advertise and browse. Throws a `LanError` when there is no identity. */
  static async start(src: LanSource, o: LanOptions = {}): Promise<LanService> {
    const s = new LanService(src, o);
    await s.#identity(true);
    await s.#loadContacts();
    await s.#listen();
    try {
      if (o.advertise !== false) await s.#rotate();
      if (o.browse !== false) await s.#startBrowse();
      s.#unContacts =
        src.onContacts?.(
          () => void s.refreshContacts().catch(() => undefined),
        ) ?? null;
    } catch (e) {
      await s.stop();
      throw e;
    }
    return s;
  }

  /** The TCP port this listen uses. */
  get port(): number {
    return this.#port;
  }

  /** Roster devices seen on the network right now. */
  peers(): LanPeer[] {
    return [...this.#peers.values()].map(({ deviceId, host, hosts, port }) => ({
      deviceId,
      host,
      hosts: [...(hosts ?? [host])],
      port,
    }));
  }

  /** Called for each pushed `RING` or `TRUST` once it is stored, applied or refused. */
  onNotice(fn: (n: ConnectNotice) => void): () => void {
    return this.#docs.onNotice(fn);
  }

  onPeer(fn: (p: LanPeer) => void): () => void {
    this.#onPeer.add(fn);
    return () => this.#onPeer.delete(fn);
  }

  /** Called for each inbound session once it is open and admitted. */
  onSession(fn: (s: ConnectSession) => void): () => void {
    this.#onSession.add(fn);
    return () => this.#onSession.delete(fn);
  }

  /** Called for each inbound mode-`c` session (a contact dialled this device) once it is open. */
  onContactSession(fn: (s: ConnectSession) => void): () => void {
    this.#onContactSession.add(fn);
    return () => this.#onContactSession.delete(fn);
  }

  /**
   * The contacts seen on this network now, by link `id` and whether it is the pending secret of a
   * re-pair (§15.10). The host picks one to dial; `connectContact` runs the handshake.
   */
  contactPeers(): { id: string; pending: boolean }[] {
    return [...this.#contactPeers.values()].map(({ id, pending }) => ({
      id,
      pending,
    }));
  }

  /**
   * Read the contacts again (stored, promoted, removed, re-marked, or the gate moved) and bring the
   * adverts, the accepted names and the listener's trial order to match. Safe to call at any time.
   */
  refreshContacts(): Promise<void> {
    const run = this.#queue.then(async () => {
      if (this.#stopped) return;
      await this.#loadContacts();
      const id = await this.#identity(true);
      await this.#advertContacts(id, advertEpoch(this.#src.now()));
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** Dial a discovered device and run the handshake. */
  async connect(target: string | LanPeer): Promise<ConnectSession> {
    if (this.#stopped)
      throw new LanError("not_listening", "The LAN service is stopped.");
    const want = typeof target === "string" ? target : target.deviceId;
    const peer = typeof target === "string" ? this.#peers.get(target) : target;
    // The address text is judged before any socket exists (a global IPv6 address is judged
    // again on the connected socket, with its own local address).
    const hosts = (peer?.hosts ?? (peer ? [peer.host] : [])).filter((h) =>
      this.#dialable(h),
    );
    if (peer === undefined || hosts.length === 0)
      throw new LanError(
        "unknown_peer",
        "That device was not found on this network.",
      );
    const id = await this.#identity(false);
    // A neighbour can answer first with its own address: when the winner of the race fails the
    // handshake, the race runs again over the addresses that are left (§15.4.1, Dialling).
    let left = [...hosts];
    let failure: LanError | null = null;
    let session: ConnectSession | null = null;
    while (left.length > 0 && session === null) {
      let socket: Socket;
      let host: string;
      try {
        ({ socket, host } = await this.#dial(left, peer.port));
      } catch (e) {
        throw e;
      }
      const link = this.#link(socket, id, "initiator");
      void link.channel.start();
      try {
        session = await link.opened;
      } catch (e) {
        socket.destroy();
        const err =
          e instanceof LanError
            ? e
            : new LanError("handshake_failed", "The handshake failed.", {
                cause: e,
              });
        if (
          err.reason !== "handshake_failed" &&
          err.reason !== "connect_failed"
        )
          throw err;
        failure = err;
        left = left.filter((h) => h !== host);
      }
    }
    if (session === null)
      throw (
        failure ?? new LanError("handshake_failed", "The handshake failed.")
      );
    if (session.peerDeviceId !== want) {
      await session.close();
      throw new LanError(
        "wrong_peer",
        "The device that answered is not the one that advertised.",
      );
    }
    return session;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#docs.close();
    this.#cancelEpoch?.();
    this.#unContacts?.();
    this.#gate.destroyPending();
    await Promise.all(
      [...this.#sessions].map((s) => s.close().catch(() => undefined)),
    );
    await Promise.all([
      this.#adv?.stop().catch(() => undefined),
      ...[...this.#contactAdv.values()].map((h) =>
        h.stop().catch(() => undefined),
      ),
      this.#browse?.stop().catch(() => undefined),
      new Promise<void>((done) => {
        if (this.#server === null) return done();
        this.#server.close(() => done());
      }),
    ]);
    this.#adv = this.#browse = null;
    this.#contactAdv.clear();
    this.#contactPeers.clear();
    wipeLive(this.#contacts);
    this.#contacts = [];
  }

  /** Stop at once: no goodbyes, nothing waited on, the held identity dropped. The sign-out
   *  bound's force path. */
  abort(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#docs.close();
    this.#cancelEpoch?.();
    this.#unContacts?.();
    this.#gate.destroyPending();
    for (const k of [...this.#links]) k.destroy();
    this.#id = null;
    void this.#adv?.stop().catch(() => undefined);
    for (const h of this.#contactAdv.values())
      void h.stop().catch(() => undefined);
    this.#contactAdv.clear();
    this.#contactPeers.clear();
    wipeLive(this.#contacts);
    this.#contacts = [];
    void this.#browse?.stop().catch(() => undefined);
    this.#adv = this.#browse = null;
    this.#server?.close();
  }

  // ── Identity ────────────────────────────────────────────────────────────────────────────────

  async #identity(force: boolean): Promise<LanIdentity> {
    const now = this.#src.now();
    if (
      !force &&
      this.#id !== null &&
      now - this.#id.at < IDENTITY_TTL_S &&
      this.#id.v.certExpiresAt - now > CERT_MARGIN_S
    )
      return this.#id.v;
    const v = await this.#src.load();
    if (this.#id !== null && this.#id.v.ringEpoch !== v.ringEpoch)
      this.#miss.clear();
    this.#id = { at: now, v };
    await this.#refreshNames(v);
    if (this.#docs.pushed !== null && this.#docs.pushed.epoch <= v.ringEpoch)
      this.#docs.pushed = null;
    return v;
  }

  /** The names `accept` lets into the adapter's tables, worked out again when the epoch, keys or roster change. */
  async #refreshNames(id: LanIdentity): Promise<void> {
    const now = this.#src.now();
    const epoch = advertEpoch(now);
    const hex = (b: Uint8Array | null): string =>
      b === null ? "-" : Buffer.from(b).toString("hex");
    const sig = `${epoch}|${hex(id.keys.current)}|${hex(id.keys.previous)}|${id.roster.join(",")}|${this.#contactsSig}`;
    if (sig === this.#namesSig) return;
    const names = new Set<string>();
    const keys = [
      id.keys.current,
      ...(id.keys.previous ? [id.keys.previous] : []),
    ];
    for (const back of [0, 1])
      for (const k of keys)
        for (const d of id.roster.slice(0, 128))
          if (d !== id.deviceId)
            names.add(await accountInstance(k, epoch - back, d));
    // The names a contact can announce (its own agreeKey in the MAC): this and the last epoch.
    for (const back of [0, 1])
      for (const c of this.#contacts)
        names.add(
          await contactInstance(c.secret, c.agreeKeyBytes, epoch - back),
        );
    this.#names = names;
    this.#namesSig = sig;
    this.#namesEpoch = epoch;
  }

  /** Read the contacts from the source; the old ones are wiped. */
  async #loadContacts(): Promise<void> {
    const next = (await this.#src.contacts?.()) ?? [];
    const old = this.#contacts;
    this.#contacts = next;
    this.#contactsSig = next
      .map((c) => `${c.id}${c.pending ? "p" : "h"}${c.reachable ? "r" : "-"}`)
      .join(",");
    wipeLive(old);
    // A handshake still running under a contact that is gone (or whose secret was replaced) or
    // while links are off is ended; an established session is the links layer's to close.
    const held = new Set(next.map((c) => `${c.id}|${c.tag}`));
    for (const [k, served] of [...this.#serves])
      if ([...served].some((x) => !held.has(x))) {
        this.#serves.delete(k);
        k.destroy();
      }
    // A peer seen under a contact that is gone is forgotten.
    const have = new Set(next.map((c) => `${c.id}|${c.pending}`));
    for (const [k, p] of this.#contactPeers)
      if (!have.has(`${p.id}|${p.pending}`)) this.#contactPeers.delete(k);
    if (this.#id !== null) await this.#refreshNames(this.#id.v);
  }

  /** The contact adverts for the contacts marked reachable, at most 8, on this listener's port. */
  async #advertContacts(id: LanIdentity, epoch: number): Promise<void> {
    if (this.#o.advertise === false) return;
    const want = new Map<string, true>();
    for (const c of this.#contacts
      .filter((x) => x.reachable)
      .slice(0, MAX_LIVE_CONTACT_ADVERTS))
      want.set(await contactInstance(c.secret, id.agreePublic, epoch), true);
    for (const [name, h] of [...this.#contactAdv]) {
      if (want.has(name)) continue;
      this.#contactAdv.delete(name);
      await h.stop().catch(() => undefined);
    }
    for (const name of want.keys()) {
      if (this.#contactAdv.has(name)) continue;
      this.#contactAdv.set(
        name,
        await this.#mdns.advertise({
          instance: name,
          port: this.#port,
          txt: ["v=1", "m=c"],
        }),
      );
    }
  }

  /** The adapter's roster filter. When the epoch has moved it starts the recount; the next packet sees it. */
  #accepts = (instance: string): boolean => {
    const held = this.#id;
    if (
      held !== null &&
      !this.#namesBusy &&
      this.#namesEpoch !== advertEpoch(this.#src.now())
    ) {
      this.#namesBusy = true;
      void this.#refreshNames(held.v)
        .catch(() => undefined)
        .finally(() => {
          this.#namesBusy = false;
        });
    }
    return this.#names.has(instance);
  };

  #link(
    socket: Socket,
    id: LanIdentity,
    role: "initiator" | "responder",
  ): SocketLink {
    // The shared listener (§15.5, §15.10): a responder that holds contacts tries the account's
    // keys, then each contact's secret, under the one limiter. Copies of the secrets go to the
    // channel; they are wiped when the link ends.
    const served = role === "responder" ? this.#contacts : [];
    const links: ContactLink[] = served.map((c) => ({
      secret: new Uint8Array(c.secret),
      agreeKey: c.agreeKey,
    }));
    const link: SocketLink = new SocketLink({
      socket,
      handshakeMs: this.#o.handshakeMs,
      contacts: served.map(refOf),
      channel: {
        mode: "a",
        role,
        ...channelBase(
          id,
          this.#o,
          () => this.#src.now(),
          () => this.#docs.pushed,
        ),
        ...(links.length > 0
          ? { contacts: links, admission: this.#limiter }
          : {}),
      },
      ...this.#docs.hooks,
      onEstablished: (s) => {
        this.#serves.delete(link);
        this.#sessions.add(s);
        s.onClose(() => this.#sessions.delete(s));
        if (s.contact?.pending) void this.#src.contactEstablished?.(s.contact);
      },
      onEnded: () => {
        this.#links.delete(link);
        this.#serves.delete(link);
        for (const l of links) l.secret.fill(0);
      },
    });
    this.#links.add(link);
    if (served.length > 0)
      this.#serves.set(link, new Set(served.map((c) => `${c.id}|${c.tag}`)));
    return link;
  }

  // ── TCP ─────────────────────────────────────────────────────────────────────────────────────

  #dialable(host: string): boolean {
    return textVerdict(host, this.#o.allowLoopback === true);
  }

  async #dial(
    hosts: readonly string[],
    port: number,
  ): Promise<{ socket: Socket; host: string }> {
    try {
      return await dialRaceTo(hosts, port, {
        allowLoopback: this.#o.allowLoopback === true,
      });
    } catch (e) {
      throw new LanError("connect_failed", "The device did not answer.", {
        cause: e,
      });
    }
  }

  async #listen(): Promise<void> {
    const server = await listenTcp(this.#o.host, this.#o.port ?? 0, (s) =>
      this.#accept(s),
    );
    this.#server = server;
    this.#port = (server.address() as { port: number }).port;
  }

  #accept(socket: Socket): void {
    const slot = this.#gate.admit(
      socket,
      this.#stopped || this.#sessions.size >= (this.#o.maxSessions ?? 64),
    );
    if (slot === null) return;
    // The identity is read before the first byte is handled.
    socket.pause();
    this.#identity(false).then(
      (id) => {
        if (socket.destroyed) return;
        const link = this.#link(socket, id, "responder");
        link.opened.then(
          (s) => {
            slot.settle();
            const to =
              s.contact !== null ? this.#onContactSession : this.#onSession;
            for (const f of [...to]) f(s);
          },
          () => undefined,
        );
        socket.resume();
      },
      () => socket.destroy(),
    );
  }

  // ── Contacts ────────────────────────────────────────────────────────────────────────────────

  async #foundContact(f: MdnsFound, hosts: string[]): Promise<void> {
    const contacts = this.#contacts;
    if (contacts.length === 0 || this.#miss.has(f.instance)) return;
    const hit = await browseContactInstance(
      f.instance,
      contacts.map((c) => ({ secret: c.secret, agreeKey: c.agreeKeyBytes })),
      this.#src.now(),
    );
    if (hit === null) {
      if (this.#miss.size >= MISS_CACHE)
        this.#miss.delete(this.#miss.keys().next().value!);
      this.#miss.set(f.instance, this.#src.now());
      return;
    }
    const c = contacts[hit.contact];
    // The list may have moved while the MACs were worked out.
    if (c === undefined || this.#contacts !== contacts) return;
    this.#contactPeers.set(`${c.id}|${c.pending}`, {
      id: c.id,
      pending: c.pending,
      instance: f.instance,
      hosts,
      port: f.port,
    });
  }

  /**
   * Dial a contact seen on this network and run the mode-`c` handshake under its secret (§15.10).
   * `pending` picks the pending secret of a re-pair. The pin is the session's: a peer that does
   * not hold the contact's key ends it as `peer_revoked` before a byte is sent back.
   */
  async connectContact(id: string, pending = false): Promise<ConnectSession> {
    if (this.#stopped)
      throw new LanError("not_listening", "The LAN service is stopped.");
    const c = this.#contacts.find((x) => x.id === id && x.pending === pending);
    const peer = this.#contactPeers.get(`${id}|${pending}`);
    const hosts = (peer?.hosts ?? []).filter((h) => this.#dialable(h));
    if (c === undefined || peer === undefined || hosts.length === 0)
      throw new LanError(
        "unknown_peer",
        "That contact was not found on this network.",
      );
    const idn = await this.#identity(false);
    const secret = new Uint8Array(c.secret);
    const ref = refOf(c);
    let left = [...hosts];
    let failure: LanError | null = null;
    try {
      while (left.length > 0) {
        const { socket, host } = await this.#dial(left, peer.port);
        const handle = new Uint8Array(32);
        const link: SocketLink = new SocketLink({
          socket,
          handshakeMs: this.#o.handshakeMs,
          contacts: [ref],
          channel: {
            mode: "c",
            role: "initiator",
            ...contactChannel(idn, this.#o, handle, () => this.#src.now()),
            contacts: [{ secret, agreeKey: c.agreeKey }],
          },
          onEstablished: (s) => {
            this.#sessions.add(s);
            s.onClose(() => this.#sessions.delete(s));
            if (s.contact?.pending)
              void this.#src.contactEstablished?.(s.contact);
          },
          onEnded: () => this.#links.delete(link),
        });
        this.#links.add(link);
        void link.channel.start();
        try {
          return await link.opened;
        } catch (e) {
          socket.destroy();
          const err =
            e instanceof LanError
              ? e
              : new LanError("handshake_failed", "The handshake failed.", {
                  cause: e,
                });
          if (
            err.reason !== "handshake_failed" &&
            err.reason !== "connect_failed"
          )
            throw err;
          failure = err;
          left = left.filter((h) => h !== host);
        }
      }
      throw (
        failure ?? new LanError("handshake_failed", "The handshake failed.")
      );
    } finally {
      // The channel needed the key for the handshake only.
      secret.fill(0);
    }
  }

  // ── mDNS ────────────────────────────────────────────────────────────────────────────────────

  /** Advertise under the current epoch and key; set the timer for the next boundary. */
  #rotate(): Promise<void> {
    const run = this.#queue.then(async () => {
      if (this.#stopped) return;
      const id = await this.#identity(true);
      const epoch = advertEpoch(this.#src.now());
      const name = await accountInstance(id.keys.current, epoch, id.deviceId);
      if (name !== this.#advName) {
        const old = this.#adv;
        this.#adv = await this.#mdns.advertise({
          instance: name,
          port: this.#port,
          txt: ["v=1", "m=a"],
        });
        this.#advName = name;
        await old?.stop().catch(() => undefined);
      }
      // Contacts: the names rotate with the epoch like the account's.
      await this.#loadContacts();
      await this.#advertContacts(id, epoch);
      const next = (epoch + 1) * ADVERT_EPOCH_SECONDS - this.#src.now();
      this.#cancelEpoch?.();
      this.#cancelEpoch = (this.#o.timer ?? defaultTimer)(
        () => void this.#rotate().catch(() => undefined),
        Math.max(1, next) * 1000,
      );
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #startBrowse(): Promise<void> {
    this.#browse = await this.#mdns.browse(
      (f) => void this.#found(f).catch(() => undefined),
      (instance) => this.#gone(instance),
      this.#accepts,
    );
  }

  #gone(instance: string): void {
    for (const [id, p] of this.#peers)
      if (p.instance === instance) this.#peers.delete(id);
    for (const [k, p] of this.#contactPeers)
      if (p.instance === instance) this.#contactPeers.delete(k);
  }

  async #found(f: MdnsFound): Promise<void> {
    // Keep the addresses that could be dialled; the connected socket is judged again.
    const hosts = f.hosts.filter((h) => this.#dialable(h));
    if (this.#stopped || hosts.length === 0) return;
    // A contact advert (`m=c`) is judged by parseContactTxt and by no other path (§15.4): the
    // generic parser answers an unknown mode, so it can never be dialled as a or v.
    if (parseContactTxt(f.txt).ok) return this.#foundContact(f, hosts);
    const txt = parseTxt(f.txt);
    if (!txt.ok || txt.mode !== "a") return;
    if (this.#miss.has(f.instance)) return;
    const id = await this.#identity(false);
    const keys = [
      id.keys.current,
      ...(id.keys.previous ? [id.keys.previous] : []),
    ];
    const hit = await browseAccountInstance(
      f.instance,
      keys,
      this.#src.now(),
      id.roster.filter((d) => d !== id.deviceId),
    );
    if (hit === null) {
      // Bounded negative cache: a forged instance is not worked out twice.
      if (this.#miss.size >= MISS_CACHE)
        this.#miss.delete(this.#miss.keys().next().value!);
      this.#miss.set(f.instance, this.#src.now());
      return;
    }
    const had = this.#peers.get(hit.deviceId);
    const peer = {
      deviceId: hit.deviceId,
      host: hosts[0]!,
      hosts,
      port: f.port,
      instance: f.instance,
    };
    this.#peers.set(hit.deviceId, peer);
    // A new address for a device already known is not a new peer.
    if (had?.port !== peer.port || had?.instance !== peer.instance)
      for (const fn of [...this.#onPeer])
        fn({
          deviceId: peer.deviceId,
          host: peer.host,
          hosts: [...hosts],
          port: peer.port,
        });
  }
}
