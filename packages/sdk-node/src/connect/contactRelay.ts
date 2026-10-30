// The contact relay (CC-19.5; WIRE-CONTRACT-V5 §15.7 "Contact rooms", §15.10): a room joins the two
// devices of one link, who may belong to two accounts. Each contact has its own room, named by the
// `rid` both sides derive from the contact secret, and each session inside it is a client-core
// `PeerChannel` in mode `c`: Noise XXpsk0 under the contact secret, the device's agreeKey as the
// static key and the pin on the contact's key.
//
// Rules this module keeps:
//  - a contact ticket is asked for with the body `{room: "c", rid}`; the answer must echo
//    `room: "c"`, else the Worker predates contact rooms and nothing is connected (client.ts);
//  - the room speaks aliases, never device ids: `from`, `to` and `MEMBERS` carry
//    SHA-256(rid || deviceId)[0..24]. This device computes its own and learns the peer's as the
//    member that is not it; nothing here sees the peer's device id, subject or certificate;
//  - the relay carries mode `c` here and nothing else; a session is bound to the one peer the room
//    can hold, and the Noise pin (the contact's agreeKey) is what names it;
//  - a room is kept for each contact marked reachable (at most `MAX_LIVE_CONTACT_ADVERTS`); any
//    other contact gets a short-lived room for one dial, stopped when its last session ends. The
//    Worker allows 30 contact tickets an hour per device, so a reconnect backs off to minutes;
//  - an envelope that fails its layout closes the socket with 1002; a SEND to an offline peer is
//    dropped by the room silently, so a dial is made only to a peer `MEMBERS` lists;
//  - the contact secret is held as a copy for the room and wiped when the room stops.

import { randomBytes } from "node:crypto";
import {
  HandshakeLimiter,
  MAX_LIVE_CONTACT_ADVERTS,
  PeerChannel,
  RelayOutbox,
  contactAlias,
  contactRid,
  decodeRelay,
  encodeRelay,
  type PeerHello,
  type SessionEvent,
} from "@polaris-key/client-core/peer";
import { printAs } from "../core/redact.js";
import { contactChannel, defaultTimer } from "./channel.js";
import {
  refOf,
  wipeLive,
  type ContactRef,
  type LiveContact,
} from "./contacts.js";
import type { LanSource } from "./lan.js";
import {
  RELAY_PROTOCOL,
  RelayError,
  type RelayGrant,
  type RelayOptions,
  type RelaySocket,
  type RelayState,
  type RelayStatus,
} from "./relay.js";
import { ConnectSession, routeRecord, type SessionClosed } from "./session.js";

/** What the contact relay needs: the LAN source (identity, DH, contacts) plus a contact ticket. */
export interface ContactRelaySource extends LanSource {
  /** `POST relay/ticket` with `{room: "c", rid}`. Throws `RelayError`. */
  contactTicket(rid: string): Promise<RelayGrant>;
}

const HANDSHAKE_MS = 30_000;
const MAX_SESSION_ID = 0xffffffff;
const ENDED_MEMORY = 64;
const MAX_ROOM_SESSIONS = 4;
/** Contact tickets are limited to 30 an hour per device (§15.7): back off in minutes. */
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 600_000;
const MAX_RETRY_AFTER_S = 3600;
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const defaultSocket = (url: string, protocols: string[]): RelaySocket =>
  new WebSocket(url, protocols) as unknown as RelaySocket;

/** One session inside a contact room. */
class RoomLink {
  readonly channel: PeerChannel;
  readonly opened: Promise<ConnectSession>;
  #session: ConnectSession | null = null;
  #settle!: {
    resolve: (s: ConnectSession) => void;
    reject: (e: RelayError) => void;
  };
  #deadline: NodeJS.Timeout;
  #ended = false;
  closing = false;
  private readonly secret: Uint8Array;

  constructor(
    readonly peer: Uint8Array,
    readonly sessionId: number,
    readonly key: string,
    private readonly role: "initiator" | "responder",
    contact: { secret: Uint8Array; agreeKey: string },
    private readonly ref: ContactRef,
    base: Omit<
      ConstructorParameters<typeof PeerChannel>[0],
      "send" | "onEvent" | "mode" | "role" | "contacts" | "admission"
    >,
    admission: HandshakeLimiter,
    private readonly out: (noise: Uint8Array) => void,
    private readonly cb: {
      onEstablished(s: ConnectSession, l: RoomLink): void;
      onEnded(l: RoomLink): void;
    },
    handshakeMs: number,
  ) {
    printAs(this, () => ({ link: "RoomLink", session: sessionId }));
    this.secret = new Uint8Array(contact.secret);
    this.opened = new Promise((resolve, reject) => {
      this.#settle = { resolve, reject };
    });
    this.opened.catch(() => undefined);
    this.channel = new PeerChannel({
      ...base,
      mode: "c",
      role,
      contacts: [{ secret: this.secret, agreeKey: contact.agreeKey }],
      ...(role === "responder" ? { admission } : {}),
      send: (noise) => this.out(noise),
      onEvent: (e) => this.#event(e),
    });
    this.#deadline = setTimeout(() => {
      void this.channel.close("peer_bye");
      this.finish({ code: "handshake_failed", byPeer: false });
    }, handshakeMs);
    this.#deadline.unref();
  }

  get ended(): boolean {
    return this.#ended;
  }

  overflow(): void {
    if (this.#ended) return;
    this.closing = true;
    void this.channel.close("peer_busy").catch(() => undefined);
    this.finish({ code: "peer_busy", byPeer: false });
  }

  #event(e: SessionEvent): void {
    switch (e.type) {
      case "established": {
        if (e.contactIndex === undefined) break;
        clearTimeout(this.#deadline);
        this.#session = new ConnectSession(
          this,
          "",
          e.caps,
          e.hello as PeerHello,
          this.role,
          "relay",
          "relay",
          this.ref,
        );
        this.cb.onEstablished(this.#session, this);
        this.#settle.resolve(this.#session);
        break;
      }
      case "record":
        routeRecord(this, this.#session, e.recordType, e.body);
        break;
      case "closed":
        this.finish({ code: e.code, byPeer: e.byPeer });
        break;
      default:
        break;
    }
  }

  lost(): void {
    this.finish({ code: "connection_lost", byPeer: false });
  }

  finish(
    c: SessionClosed,
    why: "handshake_failed" | "wrong_peer" = "handshake_failed",
  ): void {
    if (this.#ended) return;
    this.#ended = true;
    clearTimeout(this.#deadline);
    this.secret.fill(0);
    const live = this.#session;
    if (live === null)
      this.#settle.reject(
        new RelayError(why, "The contact was not admitted over the relay.", {
          closeCode: c.code,
        }),
      );
    else live.ended(c);
    this.cb.onEnded(this);
  }
}

/** The room of one contact: a socket, its members and the sessions inside. */
export class ContactRoom {
  readonly rid: string;
  #state: RelayState = "idle";
  #error: RelayError | null = null;
  #attempts = 0;
  #stopped = false;
  #started = false;
  #ws: RelaySocket | null = null;
  #open = false;
  #out: RelayOutbox | null = null;
  #own: Uint8Array | null = null;
  #peerAlias: Uint8Array | null = null;
  #links = new Map<string, RoomLink>();
  #ended: string[] = [];
  #waiters: { resolve: () => void; reject: (e: RelayError) => void }[] = [];
  #members: string[] = [];
  #onMembers = new Set<() => void>();
  #cancel: (() => void) | null = null;
  #wake: (() => void) | null = null;
  #pingCancel: (() => void) | null = null;
  #lastLimit: number | null = null;
  #notMember = 0;
  #chain: Promise<unknown> = Promise.resolve();
  readonly #secret: Uint8Array;
  readonly #limiter = new HandshakeLimiter(
    5,
    4,
    () => performance.now() / 1000,
  );

  private constructor(
    private readonly src: ContactRelaySource,
    private readonly contact: LiveContact,
    rid: string,
    private readonly o: RelayOptions,
    private readonly cb: {
      onSession(s: ConnectSession): void;
      onIdle(r: ContactRoom): void;
      onState(r: ContactRoom): void;
    },
    /** A room made for one dial: stopped when its last session ends. */
    readonly transient: boolean,
  ) {
    this.rid = rid;
    this.#secret = new Uint8Array(contact.secret);
    printAs(this, () => ({ room: "ContactRoom", state: this.#state }));
  }

  static async make(
    src: ContactRelaySource,
    contact: LiveContact,
    o: RelayOptions,
    cb: {
      onSession(s: ConnectSession): void;
      onIdle(r: ContactRoom): void;
      onState(r: ContactRoom): void;
    },
    transient: boolean,
  ): Promise<ContactRoom> {
    return new ContactRoom(
      src,
      contact,
      await contactRid(contact.secret),
      o,
      cb,
      transient,
    );
  }

  get id(): string {
    return this.contact.id;
  }
  get pending(): boolean {
    return this.contact.pending;
  }
  get status(): RelayStatus {
    return { state: this.#state, error: this.#error, attempts: this.#attempts };
  }

  /** Whether the room's peer is listed in the room now. */
  get peerOnline(): boolean {
    return this.#peerAlias !== null;
  }

  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    void this.#loop();
  }

  /** Resolves once the socket is open; rejects with the typed error when the loop is blocked. */
  ready(timeoutMs: number = this.o.openMs ?? 15_000): Promise<void> {
    if (this.#open) return Promise.resolve();
    if (this.#state === "blocked" || this.#state === "stopped")
      return Promise.reject(this.#error ?? this.#stoppedError());
    this.start();
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      this.#waiters.push(w);
      const cancel = (this.o.timer ?? defaultTimer)(() => {
        const i = this.#waiters.indexOf(w);
        if (i >= 0) this.#waiters.splice(i, 1);
        reject(
          this.#error ??
            new RelayError("not_connected", "The relay is not connected."),
        );
      }, timeoutMs);
      const done = w.resolve;
      w.resolve = () => (cancel(), done());
      const fail = w.reject;
      w.reject = (e) => (cancel(), fail(e));
    });
  }

  /** Ask the room who is in it; resolves on the answer or after `timeoutMs`. */
  async refreshMembers(timeoutMs = 2000): Promise<void> {
    if (!this.#open) return;
    await new Promise<void>((resolve) => {
      const cancel = (this.o.timer ?? defaultTimer)(done, timeoutMs);
      const off = (): void => void this.#onMembers.delete(done);
      this.#onMembers.add(done);
      function done(): void {
        off();
        cancel();
        resolve();
      }
      this.#sendEnv({ op: "list" });
    });
  }

  /** Open a session to the contact in this room: the peer must be listed (a SEND to an absent one is dropped). */
  async dial(): Promise<ConnectSession> {
    await this.ready();
    if (this.#peerAlias === null) await this.refreshMembers();
    const peer = this.#peerAlias;
    if (peer === null)
      throw new RelayError("unknown_peer", "That contact is not online.");
    const id = await this.#identity();
    const sessionId = this.#newSessionId(peer);
    const link = this.#makeLink(peer, sessionId, "initiator", id);
    if (link === null)
      throw new RelayError("busy", "Too many relay sessions are open.");
    void link.channel.start();
    try {
      return await link.opened;
    } catch (e) {
      if (e instanceof RelayError) throw e;
      throw new RelayError("handshake_failed", "The handshake failed.", {
        cause: e,
      });
    }
  }

  abort(): void {
    void this.stop(false);
  }

  async stop(graceful = true): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#cancel?.();
    this.#pingCancel?.();
    this.#wake?.();
    this.#set("stopped");
    const ws = this.#ws;
    if (graceful) {
      await Promise.all(
        [...this.#links.values()].map((l) =>
          l.channel.close("peer_bye").catch(() => undefined),
        ),
      );
      this.#out?.flush();
    } else this.#out?.clear();
    this.#out = null;
    this.#open = false;
    this.#ws = null;
    try {
      ws?.close(1000);
    } catch {
      // already closed
    }
    for (const l of [...this.#links.values()]) l.lost();
    for (const w of this.#waiters.splice(0)) w.reject(this.#stoppedError());
    this.#secret.fill(0);
  }

  // ── The connect loop ────────────────────────────────────────────────────────────────────────

  async #loop(): Promise<void> {
    while (!this.#stopped) {
      this.#set("connecting");
      let closeCode: number | null = null;
      let waitS = 0;
      try {
        const grant = await this.src.contactTicket(this.rid);
        if (this.#stopped) return;
        closeCode = await this.#session(grant);
      } catch (e) {
        if (this.#stopped) return;
        const err =
          e instanceof RelayError
            ? e
            : new RelayError("unavailable", "The relay could not be reached.", {
                cause: e,
              });
        this.#error = err;
        if (
          err.reason === "disabled" ||
          err.reason === "links_disabled" ||
          err.reason === "contact_unsupported" ||
          err.reason === "quota"
        )
          return this.#block(err);
        waitS = err.retryAfterSeconds ?? 0;
        // A refusal the loop cannot read through (rate limited, 404 gates) waits its turn.
        const wire =
          (e as { wireCode?: string }).wireCode ??
          (e as { code?: string }).code;
        if (wire === "rate_limited" && waitS === 0) waitS = 60;
      }
      if (this.#stopped) return;
      const stop = this.#afterClose(closeCode);
      if (stop !== null) return this.#block(stop);
      this.#attempts++;
      this.#set("backoff");
      await this.#sleep(
        Math.max(this.#backoff(), Math.min(waitS, MAX_RETRY_AFTER_S) * 1000),
      );
    }
  }

  #afterClose(code: number | null): RelayError | null {
    const limit = this.#lastLimit;
    this.#lastLimit = null;
    if (code === null) return null;
    if (code === 4009)
      return new RelayError("replaced", "Another socket took this room.", {
        closeCode: code,
      });
    if (code === 4003) {
      // The room is full, or links were switched off: a few tries, then stop.
      if (++this.#notMember >= 3)
        return new RelayError(
          "not_member",
          "The room does not admit this device.",
          {
            closeCode: code,
          },
        );
      return null;
    }
    this.#notMember = 0;
    if (code === 4008 && (limit === 2 || limit === 3))
      return new RelayError("quota", "The relay quota is spent.", {
        closeCode: code,
        scope: limit === 3 ? "product" : "person",
      });
    return null;
  }

  #block(e: RelayError): void {
    this.#error = e;
    this.#open = false;
    this.#set("blocked");
    for (const w of this.#waiters.splice(0)) w.reject(e);
  }

  #session(grant: RelayGrant): Promise<number | null> {
    return new Promise((resolve) => {
      let ws: RelaySocket;
      try {
        ws = (this.o.webSocket ?? defaultSocket)(grant.url, [
          RELAY_PROTOCOL,
          grant.ticket,
        ]);
      } catch {
        resolve(null);
        return;
      }
      ws.binaryType = "arraybuffer";
      this.#ws = ws;
      const out = new RelayOutbox((d) => ws.send(d), {
        ...this.o.outbox,
        ...(this.o.timer !== undefined ? { timer: this.o.timer } : {}),
      });
      this.#out = out;
      let done = false;
      let openedAt = 0;
      const cancelOpen = (this.o.timer ?? defaultTimer)(() => {
        try {
          ws.close(1000);
        } catch {
          // gone
        }
        finish(null);
      }, this.o.openMs ?? 15_000);
      const finish = (code: number | null): void => {
        if (done) return;
        done = true;
        cancelOpen();
        this.#pingCancel?.();
        const was = this.#open;
        if (was && performance.now() - openedAt >= (this.o.stableMs ?? 30_000))
          this.#attempts = 0;
        this.#open = false;
        if (this.#ws === ws) this.#ws = null;
        out.clear();
        if (this.#out === out) this.#out = null;
        this.#peerAlias = null;
        this.#members = [];
        for (const l of [...this.#links.values()]) l.lost();
        resolve(code);
      };
      ws.onopen = () => {
        if (this.#stopped) return;
        cancelOpen();
        this.#open = true;
        openedAt = performance.now();
        this.#lastLimit = null;
        this.#error = null;
        this.#set("open");
        for (const w of this.#waiters.splice(0)) w.resolve();
        this.#sendEnv({ op: "list" });
        this.#schedulePing(ws);
      };
      ws.onmessage = (ev) => {
        const bytes = toBytes(ev.data);
        if (bytes === null) return this.#refuse(ws);
        this.#chain = this.#chain
          .then(() => (this.#ws === ws ? this.#handle(ws, bytes) : undefined))
          .catch(() => this.#refuse(ws));
      };
      ws.onerror = () => undefined;
      ws.onclose = (ev) => finish(typeof ev.code === "number" ? ev.code : null);
    });
  }

  #refuse(ws: RelaySocket): void {
    try {
      ws.close(1002);
    } catch {
      // gone
    }
  }

  #schedulePing(ws: RelaySocket): void {
    const timer = this.o.timer ?? defaultTimer;
    const tick = (): void => {
      if (this.#ws !== ws || this.#stopped) return;
      this.#sendEnv({ op: "ping", data: randomBytes(8) });
      this.#pingCancel = timer(tick, this.o.pingMs ?? 25_000);
    };
    this.#pingCancel = timer(tick, this.o.pingMs ?? 25_000);
  }

  #sendEnv(m: Parameters<typeof encodeRelay>[0], force = true): boolean {
    return !this.#open || (this.#out?.send(m, force) ?? true);
  }

  async #handle(ws: RelaySocket, bytes: Uint8Array): Promise<void> {
    const m = decodeRelay("toClient", bytes);
    if (m === null) return this.#refuse(ws);
    switch (m.op) {
      case "recv":
        return this.#recv(m.from, m.session, m.noise);
      case "members": {
        const own = await this.#ownAlias();
        this.#members = m.devices.map(hex);
        // The room holds this device and the one peer: the member that is not this device.
        const peer = m.devices.find((d) => hex(d) !== hex(own)) ?? null;
        this.#peerAlias = peer;
        for (const f of [...this.#onMembers]) f();
        return;
      }
      case "gone": {
        if (
          this.#peerAlias !== null &&
          hex(this.#peerAlias) === hex(m.device)
        ) {
          this.#peerAlias = null;
          for (const l of [...this.#links.values()])
            if (hex(l.peer) === hex(m.device)) l.lost();
        }
        return;
      }
      case "limit": {
        this.#lastLimit = m.reason;
        if (m.reason === 1) this.#out?.halve();
        const reason =
          m.reason === 1 ? "rate_limited" : m.reason === 4 ? "paused" : "quota";
        this.#error = new RelayError(
          reason,
          reason === "paused"
            ? "The relay is paused."
            : reason === "quota"
              ? "The relay quota is spent."
              : "Slow down: the relay is rate limiting this device.",
          m.reason === 2 || m.reason === 3
            ? { scope: m.reason === 3 ? "product" : "person" }
            : undefined,
        );
        this.#set(this.#state);
        return;
      }
      default:
        // `ring` never comes from a contact room; `pong` needs no answer.
        return;
    }
  }

  async #recv(
    from: Uint8Array,
    session: number,
    noise: Uint8Array,
  ): Promise<void> {
    const key = `${hex(from)}:${session}`;
    const known = this.#links.get(key);
    if (known !== undefined) {
      void known.channel.receive(noise);
      return;
    }
    if (this.#ended.includes(key)) return;
    const own = await this.#ownAlias();
    // The room stamps `from`; one that is this device's own alias cannot be the peer.
    if (hex(from) === hex(own)) return;
    if (this.#peerAlias === null) this.#peerAlias = from;
    const id = await this.#identity().catch(() => null);
    if (id === null) return;
    const live = [...this.#links.values()].filter((l) => !l.ended).length;
    if (live >= (this.o.maxSessions ?? MAX_ROOM_SESSIONS)) return;
    const link = this.#makeLink(from, session, "responder", id);
    if (link === null) return;
    void link.channel.receive(noise);
  }

  #makeLink(
    peer: Uint8Array,
    sessionId: number,
    role: "initiator" | "responder",
    id: Awaited<ReturnType<LanSource["load"]>>,
  ): RoomLink | null {
    if (this.#links.size >= (this.o.maxSessions ?? MAX_ROOM_SESSIONS))
      return null;
    const key = `${hex(peer)}:${sessionId}`;
    const handle = new Uint8Array(32);
    const link: RoomLink = new RoomLink(
      peer,
      sessionId,
      key,
      role,
      { secret: this.#secret, agreeKey: this.contact.agreeKey },
      refOf(this.contact),
      contactChannel(id, this.o, handle, () => this.src.now()),
      this.#limiter,
      (noise) => {
        if (
          !this.#sendEnv(
            { op: "send", to: peer, session: sessionId, noise },
            link.closing,
          )
        )
          link.overflow();
      },
      {
        onEstablished: (s) => {
          if (s.contact?.pending) void this.src.contactEstablished?.(s.contact);
          if (role === "responder") this.cb.onSession(s);
        },
        onEnded: (l) => {
          this.#links.delete(l.key);
          this.#ended.push(l.key);
          if (this.#ended.length > ENDED_MEMORY) this.#ended.shift();
          if (this.transient && this.#links.size === 0) this.cb.onIdle(this);
        },
      },
      this.o.handshakeMs ?? HANDSHAKE_MS,
    );
    this.#links.set(key, link);
    return link;
  }

  #newSessionId(peer: Uint8Array): number {
    for (;;) {
      const n = randomBytes(4).readUInt32BE(0);
      const k = `${hex(peer)}:${n}`;
      if (
        n <= MAX_SESSION_ID &&
        !this.#links.has(k) &&
        !this.#ended.includes(k)
      )
        return n;
    }
  }

  async #identity(): Promise<Awaited<ReturnType<LanSource["load"]>>> {
    return this.src.load();
  }

  async #ownAlias(): Promise<Uint8Array> {
    if (this.#own !== null) return this.#own;
    const id = await this.#identity();
    this.#own = await contactAlias(this.rid, id.deviceId);
    return this.#own;
  }

  // ── Backoff and bookkeeping ─────────────────────────────────────────────────────────────────

  #backoff(): number {
    const base = this.o.backoffBaseMs ?? BACKOFF_BASE_MS;
    const max = this.o.backoffMaxMs ?? BACKOFF_MAX_MS;
    const cap = Math.min(max, base * 2 ** Math.min(this.#attempts - 1, 16));
    const jittered = Math.floor(
      cap / 2 + ((this.o.random ?? Math.random)() * cap) / 2,
    );
    return Math.max(this.o.backoffMinMs ?? 500, jittered);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const cancel = (this.o.timer ?? defaultTimer)(() => {
        this.#wake = null;
        resolve();
      }, ms);
      this.#cancel = cancel;
      this.#wake = () => {
        cancel();
        this.#wake = null;
        resolve();
      };
    });
  }

  #set(s: RelayState): void {
    this.#state = s;
    this.cb.onState(this);
  }

  #stoppedError(): RelayError {
    return new RelayError("stopped", "The relay is stopped.");
  }
}

/**
 * The contact rooms of one device: a room kept for each contact marked reachable, and a short-lived
 * one for a dial to any other.
 */
export class ContactRelay {
  #rooms = new Map<string, ContactRoom>();
  #stopped = false;
  #onSession = new Set<(s: ConnectSession) => void>();
  #queue: Promise<unknown> = Promise.resolve();
  #unsub: (() => void) | null = null;
  #held: LiveContact[] = [];

  constructor(
    private readonly src: ContactRelaySource,
    private readonly o: RelayOptions = {},
  ) {
    printAs(this, () => ({ service: "ContactRelay", rooms: this.#rooms.size }));
  }

  /** Keep a room for each contact marked reachable now, and follow the list. */
  async start(): Promise<void> {
    this.#unsub =
      this.src.onContacts?.(() => void this.sync().catch(() => undefined)) ??
      null;
    await this.sync();
  }

  onSession(fn: (s: ConnectSession) => void): () => void {
    this.#onSession.add(fn);
    return () => this.#onSession.delete(fn);
  }

  /** The rooms and their state, for `status()`. */
  rooms(): {
    id: string;
    pending: boolean;
    status: RelayStatus;
    transient: boolean;
  }[] {
    return [...this.#rooms.values()].map((r) => ({
      id: r.id,
      pending: r.pending,
      status: r.status,
      transient: r.transient,
    }));
  }

  /** Bring the standing rooms to match the contacts: one per reachable contact, at most 8. */
  sync(): Promise<void> {
    const run = this.#queue.then(async () => {
      if (this.#stopped) return;
      const next = (await this.src.contacts?.()) ?? [];
      const old = this.#held;
      this.#held = next;
      wipeLive(old);
      const want = new Map<string, LiveContact>();
      for (const c of next
        .filter((x) => x.reachable)
        .slice(0, MAX_LIVE_CONTACT_ADVERTS))
        want.set(`${c.id}|${c.pending}`, c);
      for (const [k, room] of [...this.#rooms]) {
        // A transient room is the dial's own; a standing one goes when its contact is gone.
        if (room.transient || want.has(k)) continue;
        this.#rooms.delete(k);
        await room.stop().catch(() => undefined);
      }
      for (const [k, c] of want) {
        const have = this.#rooms.get(k);
        if (have !== undefined && !have.transient) continue;
        if (have !== undefined) continue;
        const room = await ContactRoom.make(
          this.src,
          c,
          this.o,
          this.#cb,
          false,
        );
        if (this.#stopped) return;
        this.#rooms.set(k, room);
        room.start();
      }
    });
    this.#queue = run.catch(() => undefined);
    return run;
  }

  /** A session to a contact over its room. Throws `RelayError`. */
  async dial(id: string, pending = false): Promise<ConnectSession> {
    if (this.#stopped) throw new RelayError("stopped", "The relay is stopped.");
    const k = `${id}|${pending}`;
    let room = this.#rooms.get(k);
    if (room === undefined) {
      const c = ((await this.src.contacts?.()) ?? []).find(
        (x) => x.id === id && x.pending === pending,
      );
      if (c === undefined)
        throw new RelayError("unknown_peer", "That is not a contact.");
      room = await ContactRoom.make(this.src, c, this.o, this.#cb, true);
      wipeLive([c]);
      this.#rooms.set(k, room);
      room.start();
    }
    try {
      return await room.dial();
    } catch (e) {
      if (room.transient) void this.#drop(room);
      throw e;
    }
  }

  abort(): void {
    this.#stopped = true;
    this.#unsub?.();
    for (const r of this.#rooms.values()) r.abort();
    this.#rooms.clear();
    wipeLive(this.#held);
    this.#held = [];
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#unsub?.();
    await this.#queue.catch(() => undefined);
    await Promise.all(
      [...this.#rooms.values()].map((r) => r.stop().catch(() => undefined)),
    );
    this.#rooms.clear();
    wipeLive(this.#held);
    this.#held = [];
  }

  async #drop(room: ContactRoom): Promise<void> {
    const k = `${room.id}|${room.pending}`;
    if (this.#rooms.get(k) === room) this.#rooms.delete(k);
    await room.stop().catch(() => undefined);
  }

  readonly #cb = {
    onSession: (s: ConnectSession): void => {
      for (const f of [...this.#onSession]) f(s);
    },
    onIdle: (r: ContactRoom): void => void this.#drop(r),
    onState: (_r: ContactRoom): void => undefined,
  };
}

function toBytes(d: unknown): Uint8Array | null {
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d))
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return null;
}
