// Pairing two devices of two accounts (CC-19.5; WIRE-CONTRACT-V5 §15.10): `cloudConnect.links.pair`.
// Both people open pairing; each device advertises a pair instance (`m=p`) and browses for the
// other's, the two run mode `p` to the code (commit-reveal), each person confirms it, and the
// session's contact exchange stores a link on both devices.
//
// Rules this module keeps:
//  - the advert is `p1-` + 10 random bytes in base32 with `v=1`, `m=p` and the product tag, on a
//    listener of its own, for at most 300 s and only while the screen is open (`stop()`);
//  - who dials: both sides advertise and browse, so the one whose instance name sorts lower dials
//    and the other answers. Both apply the same rule, so a pair of devices opens one session;
//  - the code is the person's check. A `LinkOffer` is shown only once the session reached the code;
//    its `label` and `platform` are display data from a device on the LAN that nothing has
//    authenticated, to be shown as "reported by the device", never as proof of who it is;
//  - nothing is stored before both people confirm and both `CONTACT`s are read in order; a session
//    that ends first stores nothing on either side;
//  - the one-time static key is wiped when the handshake ends; the contact secret is handed to the
//    store and zeroed; no key, secret, nonce or handshake hash is in any message, repr or error;
//  - the sessions at once are bounded (4), per address (1 waiting) and by the approver limiter of
//    §15.6 (5 handshakes a minute, 4 waiting a code).

import type { Server, Socket } from "node:net";
import {
  HandshakeLimiter,
  MAX_CONTACT_CATS,
  advertEpoch,
  approverInstance,
  contactCategories,
  parseTxt,
  productTag,
  type PeerCloseCode,
  type PeerHello,
  type SessionEvent,
} from "@polaris-key/client-core/peer";
import { printAs } from "../core/redact.js";
import { defaultTimer } from "./channel.js";
import { dialRaceTo } from "./dial.js";
import { AcceptGate, listenTcp, textVerdict } from "./lanGate.js";
import {
  MulticastDnsAdapter,
  type MdnsAdapter,
  type MdnsFound,
  type MdnsHandle,
} from "./mdns.js";
import {
  LanError,
  SocketLink,
  guarded,
  nearbyHello,
  type SessionClosed,
} from "./session.js";

/** The pairing window: it closes by itself after this many seconds (§15.4). */
export const PAIR_WINDOW_SECONDS = 300;
const MAX_SESSIONS = 4;
const WAITING = 4;
const PER_MINUTE = 5;
const TRIES_PER_ADVERT = 2;
const CAT = /^[a-z0-9-]{1,32}$/;
const LABEL_MAX = 64;

const systemRandom = (n: number): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(n));

/** What pairing reads of the client. */
export interface PairSource {
  slug: string;
  /** Seconds since the epoch. */
  now(): number;
  /** This device's agreeKey, 43 base64url characters (a public key). */
  agreeKey(): Promise<string>;
  /** The agreeKey of every active contact (a peer in it is a re-pair, §15.10). */
  held(): Promise<string[]>;
  /**
   * Store the contact the exchange produced. `secret` is zeroed by the caller after this resolves.
   * Resolves with the stored link's display data, or `full` at the cap.
   */
  store(c: {
    agreeKey: string;
    secret: Uint8Array;
    label?: string;
    cats: readonly string[];
  }): Promise<
    | { stored: true; pending: boolean; id: string }
    | { stored: false; reason: "full" }
  >;
  /** The cached discovery answer is still true: links stay on (§15.10 "Gates"). */
  allowed(): boolean;
}

export interface LinkPairOptions {
  /**
   * The data categories this app asks both people to approve (at most 8, each `^[a-z0-9-]{1,32}$`,
   * no repeat). Show them next to the code. A link keeps the ones both sides listed (D-7).
   */
  categories: readonly string[];
  /**
   * This device's label, sent in `HELLO` and stored on the other device as the name of the link.
   * Name the device or the person (`"Ana's laptop"`); never an account identifier.
   */
  label?: string;
  /** Called with each nearby device that reached the code. Show it, and call `confirm()` or `decline()`. */
  onCode: (offer: LinkOffer) => void;
  /** Called once with the link made (both people confirmed and both devices stored it). */
  onLinked?: (link: PairedLink) => void;
  /** Called when a session that reached the code ends without a link. */
  onFailed?: (f: PairFailure) => void;
  /** Seconds the window stays open (default and most 300). */
  seconds?: number;
  mdns?: MdnsAdapter;
  /** Where to listen. Default `::` (both families on one port), or 0.0.0.0. */
  host?: string;
  /** Accept loopback peers. For tests and same-host use only. */
  allowLoopback?: boolean;
  handshakeMs?: number;
  /** Waiting sessions from one source address (default 1). For tests that share one. */
  maxPendingPerAddress?: number;
  timer?: (fn: () => void, ms: number) => () => void;
  mono?: () => number;
  random?: (n: number) => Uint8Array;
}

/** A nearby device at the code stage. */
export interface LinkOffer {
  /**
   * What the other device sent as its label. Unauthenticated display data: any device on the
   * network can send any label. Show it as "reported by the device" beside the code.
   */
  readonly label: string | null;
  readonly platform: string;
  /** The code both screens show, like `123 456`. The people compare it before anyone confirms. */
  readonly code: string;
  /** The categories this app asked for: list them before the person confirms. */
  readonly categories: readonly string[];
  /** The person confirmed the code on this device. The link is made when the other person does too. */
  confirm(): Promise<void>;
  /** The person declined: the session closes and nothing is stored. */
  decline(): Promise<void>;
  /** Called once when the session ends. */
  onClose(fn: (c: SessionClosed) => void): () => void;
}

/** A link just made. */
export interface PairedLink {
  /** The link's id on this device (`links.list()` has the rest). */
  id: string;
  label: string | null;
  /** The categories both people approved. */
  categories: readonly string[];
  /** The peer was already linked: the new pairing waits for its first handshake. */
  rePair: boolean;
}

export interface PairFailure {
  /** `declined` here, `timeout` the window or the exchange ran out, `full` at the cap, `closed` otherwise. */
  reason: "declined" | "timeout" | "full" | "closed";
  /** How the session ended, when it did. */
  close?: SessionClosed;
}

export interface LinkPairHandle {
  /** Close the window: the advert, the listener and every session. */
  stop(): Promise<void>;
  /** Still advertising. */
  readonly open: boolean;
}

interface Generation {
  server: Server;
  gate: AcceptGate;
  limiter: HandshakeLimiter;
  adv: MdnsHandle;
  instance: string;
}

class Live {
  hello: PeerHello | null = null;
  confirmed = false;
  linked = false;
  declined = false;
  local = false;
  dead = false;
  shown = false;
  failure: PairFailure["reason"] | null = null;
  closed: SessionClosed | null = null;
  readonly closers = new Set<(c: SessionClosed) => void>();
  constructor(
    readonly link: SocketLink,
    readonly key: Uint8Array,
  ) {}
}

export class LinkPairing implements LinkPairHandle {
  readonly #src: PairSource;
  readonly #o: LinkPairOptions;
  readonly #cats: string[];
  readonly #mdns: MdnsAdapter;
  readonly #random: (n: number) => Uint8Array;
  readonly #timer: (fn: () => void, ms: number) => () => void;
  readonly #mono: () => number;
  readonly #live = new Set<Live>();
  readonly #candidates = new Map<
    string,
    { instance: string; hosts: string[]; port: number; tries: number }
  >();
  readonly #dialing = new Set<string>();
  #gen: Generation | null = null;
  #browse: MdnsHandle | null = null;
  #cancel: (() => void) | null = null;
  #stopped = false;
  #agreeKey = "";
  #held: string[] = [];

  private constructor(src: PairSource, o: LinkPairOptions) {
    this.#src = src;
    this.#o = o;
    this.#cats = [...o.categories];
    this.#random = o.random ?? systemRandom;
    this.#timer = o.timer ?? defaultTimer;
    this.#mono = o.mono ?? ((): number => performance.now() / 1000);
    this.#mdns =
      o.mdns ?? new MulticastDnsAdapter({ allowLoopback: o.allowLoopback });
    printAs(this, () => ({ service: "LinkPairing", open: !this.#stopped }));
  }

  /** Validate, listen, advertise and browse. Throws `LanError` `bad_input` for options that break a rule. */
  static async start(
    src: PairSource,
    o: LinkPairOptions,
  ): Promise<LinkPairing> {
    LinkPairing.#check(o);
    const p = new LinkPairing(src, o);
    p.#agreeKey = await src.agreeKey();
    p.#held = await src.held();
    try {
      await p.#advertise();
      await p.#startBrowse();
    } catch (e) {
      await p.stop().catch(() => undefined);
      throw e;
    }
    const seconds = Math.min(
      o.seconds ?? PAIR_WINDOW_SECONDS,
      PAIR_WINDOW_SECONDS,
    );
    p.#cancel = p.#timer(
      () => void p.stop().catch(() => undefined),
      seconds * 1000,
    );
    return p;
  }

  static #check(o: LinkPairOptions): void {
    const bad = (m: string): never => {
      throw new LanError("bad_input", m);
    };
    if (typeof o.onCode !== "function") bad("onCode is required.");
    const c = o.categories;
    if (
      !Array.isArray(c) ||
      c.length > MAX_CONTACT_CATS ||
      !c.every((x) => typeof x === "string" && CAT.test(x)) ||
      new Set(c).size !== c.length
    )
      bad(
        "categories must be at most 8 distinct strings of a-z, 0-9 and '-' (1 to 32 characters).",
      );
    if (
      o.label !== undefined &&
      (typeof o.label !== "string" || o.label.length > LABEL_MAX)
    )
      bad("The label is not valid.");
    if (
      o.seconds !== undefined &&
      (typeof o.seconds !== "number" || !(o.seconds > 0))
    )
      bad("seconds must be above 0.");
  }

  get open(): boolean {
    return !this.#stopped;
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#cancel?.();
    this.#cancel = null;
    const g = this.#gen;
    this.#gen = null;
    const work: Promise<unknown>[] = [];
    if (g !== null) {
      g.server.close();
      g.gate.destroyPending({ keepUp: false });
      work.push(g.adv.stop().catch(() => undefined));
    }
    work.push(this.#browse?.stop().catch(() => undefined) ?? Promise.resolve());
    this.#browse = null;
    for (const l of [...this.#live]) work.push(this.#end(l, "peer_bye"));
    this.#candidates.clear();
    await Promise.all(work);
  }

  // ── Advert and browse ───────────────────────────────────────────────────────────────────────

  async #advertise(): Promise<void> {
    const o = this.#o;
    const gate = new AcceptGate({
      allowLoopback: o.allowLoopback,
      maxPending: WAITING * 2,
      maxPendingPerAddress: o.maxPendingPerAddress ?? 1,
      maxPendingPer64: 2,
      handshakeMs: o.handshakeMs,
    });
    const limiter = new HandshakeLimiter(PER_MINUTE, WAITING, this.#mono);
    let gen: Generation | null = null;
    const server = await listenTcp(o.host, 0, (s) => {
      if (gen !== null) this.#accept(gen, s);
      else s.destroy();
    });
    try {
      const port = (server.address() as { port: number }).port;
      const instance = approverInstance(this.#random);
      const h = await productTag(this.#src.slug, advertEpoch(this.#src.now()));
      const adv = await this.#mdns.advertise({
        instance,
        port,
        txt: ["v=1", "m=p", `h=${h}`],
      });
      gen = { server, gate, limiter, adv, instance };
    } catch (e) {
      server.close();
      throw e;
    }
    this.#gen = gen;
  }

  async #startBrowse(): Promise<void> {
    this.#browse = await this.#mdns.browse(
      (f) => void this.#found(f).catch(() => undefined),
      (instance) => this.#candidates.delete(instance),
    );
  }

  async #found(f: MdnsFound): Promise<void> {
    const g = this.#gen;
    if (this.#stopped || g === null || f.instance === g.instance) return;
    const txt = parseTxt(f.txt);
    if (!txt.ok || txt.mode !== "p") return;
    // The product tag of this epoch or the last: a pair advert of another product is not ours.
    const epoch = advertEpoch(this.#src.now());
    const tags = await Promise.all(
      [epoch, epoch - 1].map((e) => productTag(this.#src.slug, e)),
    );
    if (txt.h === undefined || !tags.includes(txt.h)) return;
    const hosts = f.hosts.filter((h) =>
      textVerdict(h, this.#o.allowLoopback === true),
    );
    if (hosts.length === 0) return;
    const had = this.#candidates.get(f.instance);
    this.#candidates.set(f.instance, {
      instance: f.instance,
      hosts,
      port: f.port,
      tries: had?.tries ?? 0,
    });
    this.#pump();
  }

  /** Dial the adverts that sort above this device's own (the other side dials the rest). */
  #pump(): void {
    const g = this.#gen;
    // The cached discovery answer can move under an open window (§15.10 "Gates").
    if (this.#stopped || g === null || !this.#src.allowed()) return;
    for (const c of this.#candidates.values()) {
      if (this.#live.size + this.#dialing.size >= MAX_SESSIONS) return;
      if (g.instance >= c.instance) continue;
      if (this.#dialing.has(c.instance) || c.tries >= TRIES_PER_ADVERT)
        continue;
      c.tries++;
      this.#dialing.add(c.instance);
      void this.#dial(c).finally(() => this.#dialing.delete(c.instance));
    }
  }

  async #dial(c: {
    instance: string;
    hosts: string[];
    port: number;
  }): Promise<void> {
    let socket: Socket;
    try {
      ({ socket } = await dialRaceTo(c.hosts, c.port, {
        allowLoopback: this.#o.allowLoopback === true,
      }));
    } catch {
      return;
    }
    if (this.#stopped) {
      socket.destroy();
      return;
    }
    const live = this.#makeLive(socket, "initiator", null);
    await live.link.channel.start().catch(() => undefined);
  }

  // ── Sessions ────────────────────────────────────────────────────────────────────────────────

  #accept(gen: Generation, socket: Socket): void {
    const slot = gen.gate.admit(
      socket,
      this.#stopped || !this.#src.allowed() || this.#live.size >= MAX_SESSIONS,
    );
    if (slot === null) return;
    this.#makeLive(socket, "responder", gen, slot);
    socket.resume();
  }

  #makeLive(
    socket: Socket,
    role: "initiator" | "responder",
    gen: Generation | null,
    slot: { established(): void; settle(): void } | null = null,
  ): Live {
    const key = this.#random(32);
    const ref: { live: Live | null } = { live: null };
    const link: SocketLink = new SocketLink({
      socket,
      handshakeMs: this.#o.handshakeMs,
      channel: {
        mode: "p",
        role,
        slug: this.#src.slug,
        staticKey: key,
        caps: [],
        ...(role === "responder" && gen !== null
          ? { admission: gen.limiter }
          : {}),
        exchange: {
          agreeKey: this.#agreeKey,
          held: this.#held,
          ...(this.#o.label !== undefined ? { label: this.#o.label } : {}),
          cats: this.#cats,
        },
        hello: nearbyHello(this.#src.slug, this.#o.label),
        timer: this.#timer,
      },
      onEvent: (e) => {
        if (ref.live !== null) this.#event(ref.live, e, slot);
      },
      onClosed: (c) => {
        if (ref.live !== null) this.#closed(ref.live, c, slot);
      },
    });
    const live = new Live(link, key);
    ref.live = live;
    this.#live.add(live);
    return live;
  }

  #event(
    live: Live,
    e: SessionEvent,
    slot: { established(): void } | null,
  ): void {
    switch (e.type) {
      case "established":
        slot?.established();
        // The one-time static key has done its work.
        live.key.fill(0);
        live.hello = e.hello;
        break;
      case "sas":
        this.#show(live, e.display);
        break;
      case "contact":
        void this.#store(live, e);
        break;
      default:
        break;
    }
  }

  #show(live: Live, code: string): void {
    if (live.shown || this.#stopped) return;
    live.shown = true;
    const hello = live.hello;
    const offer: LinkOffer = {
      label: hello?.label ?? null,
      platform: hello?.platform ?? "",
      code,
      categories: [...this.#cats],
      confirm: () => this.#confirm(live),
      decline: async () => {
        live.declined = true;
        live.failure = "declined";
        await this.#end(live, "peer_bye");
      },
      onClose: (fn) => {
        live.closers.add(fn);
        if (live.closed !== null) guarded(() => fn(live.closed!));
        return () => live.closers.delete(fn);
      },
    };
    guarded(() => this.#o.onCode(offer));
  }

  async #confirm(live: Live): Promise<void> {
    if (live.dead || live.confirmed) return;
    live.confirmed = true;
    // One link per window: the other devices that reached the code are closed.
    for (const other of [...this.#live])
      if (other !== live && !other.confirmed)
        await this.#end(other, "peer_bye");
    await live.link.channel.confirmSas();
  }

  async #store(
    live: Live,
    e: Extract<SessionEvent, { type: "contact" }>,
  ): Promise<void> {
    const secret = e.secret;
    try {
      const own = this.#cats;
      const cats = contactCategories(own, e.cats);
      const r = await this.#src.store({
        agreeKey: e.agreeKey,
        secret,
        ...(e.label !== undefined ? { label: e.label } : {}),
        cats,
      });
      if (!r.stored) {
        live.failure = "full";
        await this.#end(live, "peer_not_allowed");
        return;
      }
      live.linked = true;
      const paired: PairedLink = {
        id: r.id,
        label: e.label ?? null,
        categories: cats,
        rePair: r.pending,
      };
      guarded(() => this.#o.onLinked?.(paired));
      // Both CONTACTs are in: the exchange is over (§15.10).
      await this.#end(live, "peer_bye");
    } catch {
      live.failure = "closed";
      await this.#end(live, "peer_bye");
    } finally {
      secret.fill(0);
    }
  }

  #closed(live: Live, c: SessionClosed, slot: { settle(): void } | null): void {
    if (live.dead) return;
    live.dead = true;
    live.closed = c;
    live.key.fill(0);
    slot?.settle();
    this.#live.delete(live);
    for (const f of [...live.closers]) guarded(() => f(c));
    if (live.shown && !live.linked && !this.#stopped) {
      const reason =
        live.failure ?? (c.code === "peer_timeout" ? "timeout" : "closed");
      guarded(() => this.#o.onFailed?.({ reason, close: c }));
    }
    if (live.linked && !this.#stopped) void this.stop().catch(() => undefined);
    else this.#pump();
  }

  async #end(live: Live, code: PeerCloseCode): Promise<void> {
    live.local = true;
    await live.link.channel.close(code).catch(() => undefined);
  }
}
