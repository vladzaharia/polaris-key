// The LAN half of Cloud Connect (CC-08.2; WIRE-CONTRACT-V5 §15.4 to §15.6): advertise this device
// under the account instance name, browse for the person's other devices, listen on TCP and dial.
//
// Rules this module keeps:
//  - the advert is `p1-` + HMAC(K_disc, epoch, deviceId) with `v=1`, `m=a` and nothing else; it
//    is renewed at every 15-minute epoch boundary and only ever uses the newest K_disc;
//  - a browse hit is kept only if it matches a roster device (never this one) under the current
//    or previous epoch and either delivered key; everything else is dropped and not retried;
//  - the listener starts a handshake only when this device holds a verified identity. The
//    handshake (XXpsk0) and admission (certificate, ring, expiry, revocation) run in client-core;
//    a failed tag closes the socket without a word;
//  - unauthenticated sockets are bounded in number, per address and in time;
//  - the device's X25519 private key never leaves the `DeviceKeyPort`: Noise is given a handle
//    whose static-key operations call `port.dh`.

import {
  createServer,
  connect as netConnect,
  type Server,
  type Socket,
} from "node:net";
import type { TrustSet } from "@polaris-key/jws";
import {
  PeerChannel,
  accountInstance,
  advertEpoch,
  ADVERT_EPOCH_SECONDS,
  browseAccountInstance,
  parseTxt,
  webCryptoNoisePorts,
  webCryptoX25519,
  type AccountContext,
  type NoisePorts,
} from "@polaris-key/client-core/peer";
import {
  MulticastDnsAdapter,
  isLanAddress,
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
  /** Ask the Worker for a newer roster (a peer is on a newer one). Best effort. */
  refresh?(): Promise<void>;
}

export interface LanOptions {
  mdns?: MdnsAdapter;
  /** Where to listen. Default 0.0.0.0. */
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
  host: string;
  port: number;
}

const IDENTITY_TTL_S = 30;
const CERT_MARGIN_S = 60;
const MISS_CACHE = 1024;

const defaultTimer = (fn: () => void, ms: number): (() => void) => {
  const h = setTimeout(fn, ms);
  h.unref();
  return () => clearTimeout(h);
};

export class LanService {
  #server: Server | null = null;
  #port = 0;
  #mdns: MdnsAdapter;
  #adv: MdnsHandle | null = null;
  #advName = "";
  #browse: MdnsHandle | null = null;
  #cancelEpoch: (() => void) | null = null;
  #id: { at: number; v: LanIdentity } | null = null;
  #ring: { jws: string; epoch: number } | null = null;
  #peers = new Map<string, LanPeer & { instance: string }>();
  #miss = new Map<string, number>();
  #pending = new Set<Socket>();
  #perAddress = new Map<string, number>();
  #links = new Set<SocketLink>();
  #sessions = new Set<ConnectSession>();
  #onSession = new Set<(s: ConnectSession) => void>();
  #onPeer = new Set<(p: LanPeer) => void>();
  #stopped = false;
  #lastRefresh = 0;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly src: LanSource,
    private readonly o: LanOptions,
  ) {
    this.#mdns =
      o.mdns ?? new MulticastDnsAdapter({ allowLoopback: o.allowLoopback });
  }

  /** Listen, then advertise and browse. Throws a `LanError` when there is no identity. */
  static async start(src: LanSource, o: LanOptions = {}): Promise<LanService> {
    const s = new LanService(src, o);
    await s.#identity(true);
    await s.#listen();
    try {
      if (o.advertise !== false) await s.#rotate();
      if (o.browse !== false) await s.#startBrowse();
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
    return [...this.#peers.values()].map(({ deviceId, host, port }) => ({
      deviceId,
      host,
      port,
    }));
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

  /** Dial a discovered device and run the handshake. */
  async connect(target: string | LanPeer): Promise<ConnectSession> {
    if (this.#stopped)
      throw new LanError("not_listening", "The LAN service is stopped.");
    const want = typeof target === "string" ? target : target.deviceId;
    const peer = typeof target === "string" ? this.#peers.get(target) : target;
    if (peer === undefined || !this.#dialable(peer.host))
      throw new LanError(
        "unknown_peer",
        "That device was not found on this network.",
      );
    const id = await this.#identity(false);
    const socket = await this.#dial(peer);
    const link = this.#link(socket, id, "initiator");
    void link.channel.start();
    let session: ConnectSession;
    try {
      session = await link.opened;
    } catch (e) {
      if (e instanceof LanError) throw e;
      throw new LanError("handshake_failed", "The handshake failed.", {
        cause: e,
      });
    }
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
    this.#cancelEpoch?.();
    for (const s of [...this.#pending]) s.destroy();
    await Promise.all(
      [...this.#sessions].map((s) => s.close().catch(() => undefined)),
    );
    await Promise.all([
      this.#adv?.stop().catch(() => undefined),
      this.#browse?.stop().catch(() => undefined),
      new Promise<void>((done) => {
        if (this.#server === null) return done();
        this.#server.close(() => done());
      }),
    ]);
    this.#adv = this.#browse = null;
  }

  // ── Identity ────────────────────────────────────────────────────────────────────────────────

  async #identity(force: boolean): Promise<LanIdentity> {
    const now = this.src.now();
    if (
      !force &&
      this.#id !== null &&
      now - this.#id.at < IDENTITY_TTL_S &&
      this.#id.v.certExpiresAt - now > CERT_MARGIN_S
    )
      return this.#id.v;
    const v = await this.src.load();
    if (this.#id !== null && this.#id.v.ringEpoch !== v.ringEpoch)
      this.#miss.clear();
    this.#id = { at: now, v };
    if (this.#ring !== null && this.#ring.epoch <= v.ringEpoch)
      this.#ring = null;
    return v;
  }

  #account(id: LanIdentity): AccountContext {
    return {
      trust: id.trust,
      expectedAud: id.slug,
      certJws: id.certJws,
      ownSub: id.sub,
      ownDeviceId: id.deviceId,
      heldRing: () => this.#ring ?? { jws: id.ringJws, epoch: id.ringEpoch },
      discKeys: [id.keys.current, id.keys.previous],
    };
  }

  /** The static key is a handle: Noise asks for `publicKey` and `dh` on it and gets the device's. */
  #ports(id: LanIdentity, handle: Uint8Array): NoisePorts {
    return {
      ...webCryptoNoisePorts,
      x25519: {
        publicKey: async (k) =>
          k === handle ? id.agreePublic : webCryptoX25519.publicKey(k),
        dh: async (k, p) =>
          k === handle ? id.dh(p) : webCryptoX25519.dh(k, p),
      },
    };
  }

  #link(
    socket: Socket,
    id: LanIdentity,
    role: "initiator" | "responder",
  ): SocketLink {
    const handle = new Uint8Array(32);
    const link: SocketLink = new SocketLink({
      socket,
      handshakeMs: this.o.handshakeMs,
      channel: {
        mode: "a",
        role,
        slug: id.slug,
        staticKey: handle,
        account: this.#account(id),
        caps: this.o.caps ?? ["app/1"],
        hello: {
          label: this.o.label,
          platform: process.platform,
          app: id.slug,
        },
        ports: this.#ports(id, handle),
        now: () => this.src.now(),
        timer: this.o.timer,
        rekeyMessages: this.o.rekeyMessages,
        rekeySeconds: this.o.rekeySeconds,
      },
      onRing: (jws, epoch) => {
        if (this.#ring === null || epoch > this.#ring.epoch)
          this.#ring = { jws, epoch };
      },
      onRingWanted: () => this.#wantRing(),
      onEstablished: (s) => {
        this.#sessions.add(s);
        s.onClose(() => this.#sessions.delete(s));
      },
      onEnded: () => this.#links.delete(link),
    });
    this.#links.add(link);
    return link;
  }

  #wantRing(): void {
    const t = this.src.now();
    if (this.src.refresh === undefined || t - this.#lastRefresh < 60) return;
    this.#lastRefresh = t;
    void this.src
      .refresh()
      .then(
        () => this.#identity(true),
        () => undefined,
      )
      .catch(() => undefined);
  }

  // ── TCP ─────────────────────────────────────────────────────────────────────────────────────

  #dialable(host: string): boolean {
    return isLanAddress(host, this.o.allowLoopback === true);
  }

  #dial(peer: LanPeer): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = netConnect({ host: peer.host, port: peer.port });
      const t = setTimeout(() => s.destroy(new Error("timeout")), 10_000);
      s.once("connect", () => {
        clearTimeout(t);
        s.removeAllListeners("error");
        resolve(s);
      });
      s.once("error", (e) => {
        clearTimeout(t);
        reject(
          new LanError("connect_failed", "The device did not answer.", {
            cause: e,
          }),
        );
      });
    });
  }

  async #listen(): Promise<void> {
    const server = createServer({ noDelay: true }, (s) => this.#accept(s));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.o.port ?? 0, this.o.host ?? "0.0.0.0", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    server.on("error", () => undefined);
    this.#port = (server.address() as { port: number }).port;
  }

  #accept(socket: Socket): void {
    const addr = socket.remoteAddress ?? "";
    const per = this.#perAddress.get(addr) ?? 0;
    if (
      this.#stopped ||
      this.#pending.size >= (this.o.maxPending ?? 32) ||
      per >= (this.o.maxPendingPerAddress ?? 4) ||
      this.#sessions.size >= (this.o.maxSessions ?? 64) ||
      !this.#dialable(addr.replace(/^::ffff:/, ""))
    ) {
      socket.destroy();
      return;
    }
    this.#pending.add(socket);
    this.#perAddress.set(addr, per + 1);
    const done = (): void => {
      if (!this.#pending.delete(socket)) return;
      const n = (this.#perAddress.get(addr) ?? 1) - 1;
      if (n <= 0) this.#perAddress.delete(addr);
      else this.#perAddress.set(addr, n);
    };
    socket.once("close", done);
    // The identity is read before the first byte is handled.
    socket.pause();
    this.#identity(false).then(
      (id) => {
        if (socket.destroyed) return;
        const link = this.#link(socket, id, "responder");
        link.opened.then(
          (s) => {
            done();
            for (const f of [...this.#onSession]) f(s);
          },
          () => undefined,
        );
        socket.resume();
      },
      () => socket.destroy(),
    );
  }

  // ── mDNS ────────────────────────────────────────────────────────────────────────────────────

  /** Advertise under the current epoch and key; set the timer for the next boundary. */
  #rotate(): Promise<void> {
    const run = this.#queue.then(async () => {
      if (this.#stopped) return;
      const id = await this.#identity(true);
      const epoch = advertEpoch(this.src.now());
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
      const next = (epoch + 1) * ADVERT_EPOCH_SECONDS - this.src.now();
      this.#cancelEpoch?.();
      this.#cancelEpoch = (this.o.timer ?? defaultTimer)(
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
    );
  }

  #gone(instance: string): void {
    for (const [id, p] of this.#peers)
      if (p.instance === instance) this.#peers.delete(id);
  }

  async #found(f: MdnsFound): Promise<void> {
    if (this.#stopped || !this.#dialable(f.host)) return;
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
      this.src.now(),
      id.roster.filter((d) => d !== id.deviceId),
    );
    if (hit === null) {
      // Bounded negative cache: a forged instance is not worked out twice.
      if (this.#miss.size >= MISS_CACHE)
        this.#miss.delete(this.#miss.keys().next().value!);
      this.#miss.set(f.instance, this.src.now());
      return;
    }
    const peer = {
      deviceId: hit.deviceId,
      host: f.host,
      port: f.port,
      instance: f.instance,
    };
    this.#peers.set(hit.deviceId, peer);
    for (const fn of [...this.#onPeer])
      fn({ deviceId: peer.deviceId, host: peer.host, port: peer.port });
  }
}
