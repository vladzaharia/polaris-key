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
//    whose static-key operations call `port.dh`;
//  - local links (CC-29.8, §15.5 "One listener, one order", §15.12 "Mode l"): the same listener also
//    tries the local-link secrets after the account keys and the contacts, under the one limiter,
//    and advertises `m=l` names for the links the host marked reachable (at most 8). With no
//    account (`startLocal`) the service has no identity: it serves local links only and advertises
//    and browses no account name. Every local call reads the gate again (`localAllowed`).

import type { Server, Socket } from "node:net";
import type { TrustSet } from "@polaris-key/jws";
import {
  accountInstance,
  advertEpoch,
  ADVERT_EPOCH_SECONDS,
  browseAccountInstance,
  browseContactInstance,
  browseLocalInstance,
  contactInstance,
  HandshakeLimiter,
  localInstance,
  MAX_LIVE_CONTACT_ADVERTS,
  MAX_LIVE_LOCAL_ADVERTS,
  parseContactTxt,
  parseLocalTxt,
  parseTxt,
  type ContactLink,
  type LocalLink,
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
  localChannel,
  type ConnectNotice,
  type RingAdoption,
  type TrustApplication,
} from "./channel.js";
import { dialRaceTo } from "./dial.js";
import {
  refOfLocal,
  wipeLocals,
  type LiveLocal,
  type LocalRef,
} from "./localState.js";
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
  /** The product slug. A service with no identity (`startLocal`) has no other way to know it. */
  slug?: string;
  /**
   * The local links (§15.12) in held order, secrets and keys decoded: empty while the gate is off
   * or none are held. The service wipes what it replaces.
   */
  locals?(): Promise<LiveLocal[]>;
  /** Called when the local links changed (added, removed, renamed, re-marked) or the gate moved. */
  onLocals?(fn: () => void): () => void;
  /** The cached `localPairing` answer, read again for every local call (§15.12 "Gates"). */
  localAllowed?(): boolean;
  /** A session opened under a local link: its last-seen time moves. */
  localEstablished?(ref: LocalRef): Promise<void>;
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

/**
 * A dial that failed before the transport (the connection closed, a tag failed, the deadline ran
 * out) is the next address's to try; any other failure ends the dial.
 */
function retryable(e: unknown): LanError {
  const err =
    e instanceof LanError
      ? e
      : new LanError("handshake_failed", "The handshake failed.", { cause: e });
  if (err.reason !== "handshake_failed" && err.reason !== "connect_failed")
    throw err;
  return err;
}

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
  /** No account: the service serves local links only (`startLocal`). */
  #localOnly = false;
  /** The local links held now (empty while the gate is off), in held order. */
  #locals: LiveLocal[] = [];
  #localsSig = "";
  /** One live `m=l` advert per name; at most `MAX_LIVE_LOCAL_ADVERTS`. */
  #localAdv = new Map<string, MdnsHandle>();
  #localPeers = new Map<
    string,
    { id: string; instance: string; hosts: string[]; port: number }
  >();
  #onLocalSession = new Set<(s: ConnectSession) => void>();
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
  static start(src: LanSource, o: LanOptions = {}): Promise<LanService> {
    return LanService.#begin(src, o, false);
  }

  /**
   * The service with no account (§15.5, §15.12): it listens, and advertises and browses `m=l` names
   * for the local links, and holds no identity, no K_disc and no roster. A listener that serves
   * nothing (no link held, or the gate off) closes every connection before reading a byte. Needs
   * `src.slug`.
   */
  static startLocal(src: LanSource, o: LanOptions = {}): Promise<LanService> {
    if (src.slug === undefined)
      throw new LanError("bad_input", "A local-only service needs the slug.");
    return LanService.#begin(src, o, true);
  }

  static async #begin(
    src: LanSource,
    o: LanOptions,
    localOnly: boolean,
  ): Promise<LanService> {
    const s = new LanService(src, o);
    s.#localOnly = localOnly;
    if (!localOnly) {
      await s.#identity(true);
      await s.#loadContacts();
    }
    await s.#loadLocals();
    await s.#listen();
    try {
      if (o.advertise !== false) await s.#rotate();
      if (o.browse !== false) await s.#startBrowse();
      const refresh = (): void =>
        void s.refreshContacts().catch(() => undefined);
      const offs = [src.onContacts?.(refresh), src.onLocals?.(refresh)];
      s.#unContacts = (): void => {
        for (const f of offs) f?.();
      };
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

  /** Called for each inbound mode-`l` session (a local link dialled this device) once it is open. */
  onLocalSession(fn: (s: ConnectSession) => void): () => void {
    this.#onLocalSession.add(fn);
    return () => this.#onLocalSession.delete(fn);
  }

  /** The local links seen on this network now, by link `id`. The host picks one to dial (`connectLocal`). */
  localPeers(): { id: string }[] {
    return [...this.#localPeers.values()].map(({ id }) => ({ id }));
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
      // The local links first: a withdrawal (the gate moved, a link was forgotten) must not wait
      // on the account half, which can fail when there is no account.
      await this.#loadLocals();
      await this.#advertLocals(advertEpoch(this.#src.now()));
      if (this.#localOnly) return;
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
        failure = retryable(e);
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
      ...[...this.#contactAdv.values(), ...this.#localAdv.values()].map((h) =>
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
    this.#localAdv.clear();
    this.#localPeers.clear();
    wipeLive(this.#contacts);
    this.#contacts = [];
    wipeLocals(this.#locals);
    this.#locals = [];
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
    for (const h of [...this.#contactAdv.values(), ...this.#localAdv.values()])
      void h.stop().catch(() => undefined);
    this.#contactAdv.clear();
    this.#contactPeers.clear();
    this.#localAdv.clear();
    this.#localPeers.clear();
    wipeLive(this.#contacts);
    this.#contacts = [];
    wipeLocals(this.#locals);
    this.#locals = [];
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
    await this.#refreshNames();
    if (this.#docs.pushed !== null && this.#docs.pushed.epoch <= v.ringEpoch)
      this.#docs.pushed = null;
    return v;
  }

  /** The names `accept` lets into the adapter's tables, worked out again when the epoch, keys or roster change. */
  async #refreshNames(): Promise<void> {
    const id = this.#id?.v ?? null;
    const now = this.#src.now();
    const epoch = advertEpoch(now);
    const hex = (b: Uint8Array | null): string =>
      b === null ? "-" : Buffer.from(b).toString("hex");
    const sig =
      `${epoch}|${id === null ? "-" : `${hex(id.keys.current)}|${hex(id.keys.previous)}|${id.roster.join(",")}`}` +
      `|${this.#contactsSig}|${this.#localsSig}`;
    if (sig === this.#namesSig) return;
    const names = new Set<string>();
    if (id !== null) {
      const keys = [
        id.keys.current,
        ...(id.keys.previous ? [id.keys.previous] : []),
      ];
      for (const back of [0, 1])
        for (const k of keys)
          for (const d of id.roster.slice(0, 128))
            if (d !== id.deviceId)
              names.add(await accountInstance(k, epoch - back, d));
    }
    // The names a local link's peer can announce (its own link key in the MAC). The secrets are
    // copied first: a reload may wipe the held ones while the MACs are worked out.
    const locals = this.#locals.map((l) => ({
      secret: l.secret.slice(),
      peerKey: l.peerKey,
    }));
    try {
      for (const back of [0, 1])
        for (const l of locals)
          names.add(await localInstance(l.secret, l.peerKey, epoch - back));
    } finally {
      for (const l of locals) l.secret.fill(0);
    }
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
    this.#pruneServes();
    // A peer seen under a contact that is gone is forgotten.
    const have = new Set(next.map((c) => `${c.id}|${c.pending}`));
    for (const [k, p] of this.#contactPeers)
      if (!have.has(`${p.id}|${p.pending}`)) this.#contactPeers.delete(k);
    if (this.#id !== null) await this.#refreshNames();
  }

  /**
   * A handshake still running under a contact or local link that is gone (or whose secret was
   * replaced), or while links are off, is ended; an established session is the links layer's to
   * close.
   */
  #pruneServes(): void {
    const held = new Set([
      ...this.#contacts.map((c) => `c|${c.id}|${c.tag}`),
      ...this.#locals.map((l) => `l|${l.id}|${l.tag}`),
    ]);
    for (const [k, served] of [...this.#serves])
      if ([...served].some((x) => !held.has(x))) {
        this.#serves.delete(k);
        k.destroy();
      }
  }

  /** Read the local links from the source; the old ones are wiped. */
  async #loadLocals(): Promise<void> {
    const next = (await this.#src.locals?.()) ?? [];
    const old = this.#locals;
    this.#locals = next;
    const sig = next
      .map((l) => `${l.id}${l.tag}${l.reachable ? "r" : "-"}`)
      .join(",");
    // A name judged a miss before a link existed may be that link's.
    if (sig !== this.#localsSig) this.#miss.clear();
    this.#localsSig = sig;
    wipeLocals(old);
    this.#pruneServes();
    // A peer seen under a link that is gone is forgotten.
    const have = new Set(next.map((l) => l.id));
    for (const k of [...this.#localPeers.keys()])
      if (!have.has(k)) this.#localPeers.delete(k);
    if (this.#id !== null || this.#localOnly) await this.#refreshNames();
  }

  /** The gate, read again: false stops every local call (§15.12 "Gates"). */
  #localsOn(): boolean {
    return this.#src.localAllowed?.() !== false;
  }

  /** The contact adverts for the contacts marked reachable, at most 8, on this listener's port. */
  async #advertContacts(id: LanIdentity, epoch: number): Promise<void> {
    if (this.#o.advertise === false) return;
    const want = new Set<string>();
    for (const c of this.#contacts
      .filter((x) => x.reachable)
      .slice(0, MAX_LIVE_CONTACT_ADVERTS))
      want.add(await contactInstance(c.secret, id.agreePublic, epoch));
    await this.#syncAdverts(this.#contactAdv, want, "c");
  }

  /** The `m=l` adverts for the links marked reachable, at most 8, on this listener's port. */
  async #advertLocals(epoch: number): Promise<void> {
    if (this.#o.advertise === false) return;
    const want = new Set<string>();
    if (this.#localsOn())
      for (const l of this.#locals
        .filter((x) => x.reachable)
        .slice(0, MAX_LIVE_LOCAL_ADVERTS))
        want.add(await localInstance(l.secret, l.ownPublic, epoch));
    await this.#syncAdverts(this.#localAdv, want, "l");
  }

  /** Bring the live adverts of one mode to exactly `want`: stop the others, start the missing. */
  async #syncAdverts(
    live: Map<string, MdnsHandle>,
    want: ReadonlySet<string>,
    mode: "c" | "l",
  ): Promise<void> {
    for (const [name, h] of [...live]) {
      if (want.has(name)) continue;
      live.delete(name);
      await h.stop().catch(() => undefined);
    }
    for (const name of want) {
      if (live.has(name) || this.#stopped) continue;
      live.set(
        name,
        await this.#mdns.advertise({
          instance: name,
          port: this.#port,
          txt: ["v=1", `m=${mode}`],
        }),
      );
    }
  }

  /** The adapter's roster filter. When the epoch has moved it starts the recount; the next packet sees it. */
  #accepts = (instance: string): boolean => {
    if (
      (this.#id !== null || this.#localOnly) &&
      !this.#namesBusy &&
      this.#namesEpoch !== advertEpoch(this.#src.now())
    ) {
      this.#namesBusy = true;
      void this.#refreshNames()
        .catch(() => undefined)
        .finally(() => {
          this.#namesBusy = false;
        });
    }
    return this.#names.has(instance);
  };

  #link(
    socket: Socket,
    id: LanIdentity | null,
    role: "initiator" | "responder",
  ): SocketLink {
    // The shared listener (§15.5, §15.10, §15.12): a responder that holds contacts or local links
    // tries the account's keys, then each contact's secret, then each local link's, under the one
    // limiter. Copies of the secrets go to the channel; they are wiped when the link ends.
    const served = role === "responder" ? this.#contacts : [];
    const live = role === "responder" && this.#localsOn() ? this.#locals : [];
    const links: ContactLink[] = served.map((c) => ({
      secret: new Uint8Array(c.secret),
      agreeKey: c.agreeKey,
    }));
    const locals: LocalLink[] = live.map((l) => ({
      secret: new Uint8Array(l.secret),
      ownKey: new Uint8Array(l.ownKey),
      peerKey: new Uint8Array(l.peerKey),
    }));
    const trial = links.length > 0 || locals.length > 0;
    const now = (): number => this.#src.now();
    const link: SocketLink = new SocketLink({
      socket,
      handshakeMs: this.#o.handshakeMs,
      contacts: served.map(refOf),
      locals: live.map(refOfLocal),
      channel:
        id === null
          ? {
              // No account: the listener serves local links alone, and the mode is `l`.
              mode: "l",
              role,
              ...localChannel(this.#slug(), this.#o, now),
              locals,
              admission: this.#limiter,
            }
          : {
              mode: "a",
              role,
              ...channelBase(id, this.#o, now, () => this.#docs.pushed),
              ...(links.length > 0 ? { contacts: links } : {}),
              ...(locals.length > 0 ? { locals } : {}),
              ...(trial ? { admission: this.#limiter } : {}),
            },
      ...this.#docs.hooks,
      onEstablished: (s) => {
        this.#serves.delete(link);
        this.#sessions.add(s);
        s.onClose(() => this.#sessions.delete(s));
        if (s.contact?.pending) void this.#src.contactEstablished?.(s.contact);
        if (s.local !== null)
          void this.#src.localEstablished?.(s.local)?.catch(() => undefined);
      },
      onEnded: () => {
        this.#links.delete(link);
        this.#serves.delete(link);
        for (const l of links) l.secret.fill(0);
        for (const l of locals) {
          l.secret.fill(0);
          l.ownKey.fill(0);
        }
      },
    });
    this.#links.add(link);
    if (trial)
      this.#serves.set(
        link,
        new Set([
          ...served.map((c) => `c|${c.id}|${c.tag}`),
          ...live.map((l) => `l|${l.id}|${l.tag}`),
        ]),
      );
    return link;
  }

  #slug(): string {
    return this.#src.slug ?? this.#id?.v.slug ?? "";
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
      this.#stopped ||
        this.#sessions.size >= (this.#o.maxSessions ?? 64) ||
        // With no account the listener serves local links alone: with none to try (or the gate
        // off) a connection is closed before a byte is read.
        (this.#localOnly && (this.#locals.length === 0 || !this.#localsOn())),
    );
    if (slot === null) return;
    // The identity is read before the first byte is handled.
    socket.pause();
    (this.#localOnly ? Promise.resolve(null) : this.#identity(false)).then(
      (id) => {
        if (socket.destroyed) return;
        const link = this.#link(socket, id, "responder");
        link.opened.then(
          (s) => {
            slot.settle();
            const to =
              s.contact !== null
                ? this.#onContactSession
                : s.local !== null
                  ? this.#onLocalSession
                  : this.#onSession;
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

  /** Bounded negative cache: a forged instance is not worked out twice. */
  #remember(instance: string): void {
    if (this.#miss.size >= MISS_CACHE)
      this.#miss.delete(this.#miss.keys().next().value!);
    this.#miss.set(instance, this.#src.now());
  }

  async #foundContact(f: MdnsFound, hosts: string[]): Promise<void> {
    const contacts = this.#contacts;
    if (contacts.length === 0 || this.#miss.has(f.instance)) return;
    const hit = await browseContactInstance(
      f.instance,
      contacts.map((c) => ({ secret: c.secret, agreeKey: c.agreeKeyBytes })),
      this.#src.now(),
    );
    if (hit === null) {
      this.#remember(f.instance);
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
          failure = retryable(e);
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

  // ── Local links ─────────────────────────────────────────────────────────────────────────────

  async #foundLocal(f: MdnsFound, hosts: string[]): Promise<void> {
    const locals = this.#locals;
    if (locals.length === 0 || !this.#localsOn() || this.#miss.has(f.instance))
      return;
    // At most 64 HMACs, on copies: a reload may wipe the held secrets while they are worked out.
    const keys = locals.map((l) => ({
      secret: l.secret.slice(),
      peerKey: l.peerKey,
    }));
    let hit;
    try {
      hit = await browseLocalInstance(f.instance, keys, this.#src.now());
    } finally {
      for (const k of keys) k.secret.fill(0);
    }
    // The list may have moved while the MACs were worked out: nothing is learned or cached.
    if (this.#locals !== locals || this.#stopped) return;
    if (hit === null) {
      this.#remember(f.instance);
      return;
    }
    const l = locals[hit.link]!;
    this.#localPeers.set(l.id, {
      id: l.id,
      instance: f.instance,
      hosts,
      port: f.port,
    });
  }

  /**
   * Dial a local link seen on this network and run the mode-`l` handshake under its secret
   * (§15.12). The gate and the held list are read again before every dial. The pin is the
   * session's: a peer that does not hold the link's key ends it as `peer_revoked` before a byte is
   * sent back.
   */
  async connectLocal(id: string): Promise<ConnectSession> {
    if (this.#stopped)
      throw new LanError("not_listening", "The LAN service is stopped.");
    const l = this.#locals.find((x) => x.id === id);
    const peer = this.#localPeers.get(id);
    const hosts = (peer?.hosts ?? []).filter((h) => this.#dialable(h));
    if (l === undefined || peer === undefined || hosts.length === 0)
      throw new LanError(
        "unknown_peer",
        "That link was not found on this network.",
      );
    const ref = refOfLocal(l);
    let left = [...hosts];
    let failure: LanError | null = null;
    while (left.length > 0) {
      // The gate and the link are read again for every dial (§15.12 "Gates").
      const still = this.#locals.find((x) => x.id === id && x.tag === ref.tag);
      if (this.#stopped || !this.#localsOn() || still === undefined)
        throw new LanError("closed", "That link is no longer available.");
      const { socket, host } = await this.#dial(left, peer.port);
      const own: LocalLink = {
        secret: new Uint8Array(still.secret),
        ownKey: new Uint8Array(still.ownKey),
        peerKey: new Uint8Array(still.peerKey),
      };
      const wipe = (): void => {
        own.secret.fill(0);
        own.ownKey.fill(0);
      };
      const link: SocketLink = new SocketLink({
        socket,
        handshakeMs: this.#o.handshakeMs,
        locals: [ref],
        channel: {
          mode: "l",
          role: "initiator",
          ...localChannel(this.#slug(), this.#o, () => this.#src.now()),
          locals: [own],
        },
        onEstablished: (s) => {
          this.#sessions.add(s);
          s.onClose(() => this.#sessions.delete(s));
          if (s.local !== null)
            void this.#src.localEstablished?.(s.local)?.catch(() => undefined);
        },
        onEnded: () => this.#links.delete(link),
      });
      this.#links.add(link);
      void link.channel.start();
      try {
        return await link.opened;
      } catch (e) {
        socket.destroy();
        failure = retryable(e);
        left = left.filter((h) => h !== host);
      } finally {
        // The channel needed the key for the handshake only.
        wipe();
      }
    }
    throw failure ?? new LanError("handshake_failed", "The handshake failed.");
  }

  // ── mDNS ────────────────────────────────────────────────────────────────────────────────────

  /** Advertise under the current epoch and key; set the timer for the next boundary. */
  #rotate(): Promise<void> {
    const run = this.#queue.then(async () => {
      if (this.#stopped) return;
      const epoch = advertEpoch(this.#src.now());
      if (!this.#localOnly) {
        const id = await this.#identity(true);
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
      }
      // Local links: their names rotate with the epoch too.
      await this.#loadLocals();
      await this.#advertLocals(epoch);
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
    for (const [k, p] of this.#localPeers)
      if (p.instance === instance) this.#localPeers.delete(k);
  }

  async #found(f: MdnsFound): Promise<void> {
    // Keep the addresses that could be dialled; the connected socket is judged again.
    const hosts = f.hosts.filter((h) => this.#dialable(h));
    if (this.#stopped || hosts.length === 0) return;
    // A local-link advert (`m=l`) is judged by parseLocalTxt and by no other path (§15.4).
    if (parseLocalTxt(f.txt).ok) return this.#foundLocal(f, hosts);
    if (this.#localOnly) return;
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
      this.#remember(f.instance);
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
