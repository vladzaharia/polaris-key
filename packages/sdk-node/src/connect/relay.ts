// The relay half of Cloud Connect (CC-08.3; WIRE-CONTRACT-V5 §15.7): one WebSocket to the account
// room carries envelopes, and each peer session inside it is a client-core `PeerChannel` in mode
// `a`, admitted exactly as on the LAN (Noise XXpsk0, certificate, roster, expiry, revocation).
//
// Rules this module keeps:
//  - a ticket is single use and lives 60 s, so every connect fetches a new one; the socket is
//    opened with `Sec-WebSocket-Protocol: pkey-relay.1, <ticket>` and the ticket is never logged
//    or kept past the open;
//  - the relay carries mode `a` only. Modes `v` (nearby approval) and `p` (pairing) never cross
//    it (§15.7, L-9): `RelayService` builds every channel with the literal mode `a`, and
//    `assertRelayMode` refuses any other;
//  - the room stamps `from`; this client never trusts it for identity. A session is bound to the
//    peer that the Noise certificate proves, and a mismatch with the stamp closes it;
//  - an envelope that fails its layout closes the socket with 1002; nothing is answered;
//  - sessions are bounded (total, per peer, and a short memory of ended ones so late messages are
//    dropped without work);
//  - reconnects back off exponentially with jitter. A quota or a product that turned the relay
//    off ends the loop with a typed error; a paused relay waits for the longer of `Retry-After`
//    and the backoff; a replaced socket (4009) does not fight back.

import { randomBytes } from "node:crypto";
import { PolarisError } from "@polaris-key/client-core";
import { ErrorCode } from "../constants.generated.js";
import { printAs } from "../core/redact.js";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import {
  PeerChannel,
  decodeRelay,
  deviceIdBytes,
  encodeRelay,
  RelayOutbox,
  type RelayOutboxOptions,
  type PeerHello,
  type PeerSessionOptions,
  type SessionEvent,
} from "@polaris-key/client-core/peer";
import {
  PeerDocs,
  channelBase,
  defaultTimer,
  type ConnectNotice,
} from "./channel.js";
import type { LanIdentity, LanSource } from "./lan.js";
import {
  ConnectSession,
  routeRecord,
  type SessionCloseCode,
  type SessionClosed,
} from "./session.js";

export const RELAY_PROTOCOL = "pkey-relay.1";
/** The only PeerChannel mode that may cross the relay. */
export const RELAY_MODES = ["a"] as const;

/** Throws for a mode the relay must never carry (`v`, `p`, anything else). */
export function assertRelayMode(mode: string): "a" {
  if (mode !== "a")
    throw new RelayError(
      "mode_not_allowed",
      `Mode ${mode} never crosses the relay; it is LAN only.`,
    );
  return "a";
}

export type RelayErrorReason =
  /** The product turned its relay off (403 `relay_disabled`). */
  | "disabled"
  /** The deployment paused the relay (503 `relay_paused`). */
  | "paused"
  /** A relay byte quota is spent (429 `relay_quota_exceeded`, or a LIMIT 2 or 3). */
  | "quota"
  | "rate_limited"
  | "ticket_invalid"
  | "unavailable"
  | "not_member"
  | "replaced"
  | "not_connected"
  | "unknown_peer"
  | "handshake_failed"
  | "wrong_peer"
  | "busy"
  | "mode_not_allowed"
  | "stopped";

/** The registered code of each reason: the Worker's own for the four it answers with. */
const RELAY_CODE: Record<RelayErrorReason, string> = {
  disabled: ErrorCode.relayDisabled,
  paused: ErrorCode.relayPaused,
  quota: ErrorCode.relayQuotaExceeded,
  ticket_invalid: ErrorCode.relayTicketInvalid,
  rate_limited: ErrorCode.rateLimited,
  busy: ErrorCode.rateLimited,
  unavailable: ErrorCode.networkError,
  not_connected: ErrorCode.connectUnavailable,
  not_member: ErrorCode.peerCertInvalid,
  handshake_failed: ErrorCode.peerCertInvalid,
  wrong_peer: ErrorCode.peerCertInvalid,
  unknown_peer: ErrorCode.invalidArgument,
  mode_not_allowed: ErrorCode.invalidArgument,
  replaced: ErrorCode.cancelled,
  stopped: ErrorCode.cancelled,
};

export class RelayError extends PolarisError {
  readonly scope: "person" | "product" | undefined;
  readonly closeCode: SessionCloseCode | number | undefined;
  constructor(
    readonly reason: RelayErrorReason,
    message: string,
    options?: {
      cause?: unknown;
      retryAfterSeconds?: number;
      scope?: "person" | "product";
      closeCode?: SessionCloseCode | number;
      /** For a refusal at the ticket route: the HTTP status. */
      status?: number;
    },
  ) {
    super(RELAY_CODE[reason], message, {
      ...(options?.cause !== undefined ? { cause: options.cause } : {}),
      ...(options?.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: options.retryAfterSeconds }
        : {}),
      ...(options?.status !== undefined ? { status: options.status } : {}),
    });
    this.name = "RelayError";
    this.scope = options?.scope;
    this.closeCode = options?.closeCode;
  }
}

/** The ticket answer (§15.7), already checked by the source. */
export interface RelayGrant {
  ticket: string;
  url: string;
  protocol: string;
  /** Seconds since the epoch. */
  expiresAt: number;
}

/** What the relay needs of the client: the LAN source's identity plus a ticket. */
export interface RelaySource extends LanSource {
  /** Trade the bearer for a ticket. Throws `RelayError` for the typed refusals. */
  ticket(): Promise<RelayGrant>;
}

/** The slice of `WebSocket` the relay uses; the global one in Node 22 satisfies it. */
export interface RelaySocket {
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface RelayOptions {
  /** Open the socket. Default: the global `WebSocket`. */
  webSocket?: (url: string, protocols: string[]) => RelaySocket;
  caps?: readonly string[];
  label?: string;
  /** Schedule `fn` after `ms`; returns the cancel. Default `setTimeout`, unref'd. */
  timer?: (fn: () => void, ms: number) => () => void;
  /** In [0, 1). Default `Math.random`. */
  random?: () => number;
  /** Reconnect backoff: base 1 s, doubling to 60 s, with jitter. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** The least a reconnect waits (default 500 ms). */
  backoffMinMs?: number;
  /** How long a socket must stay open before the backoff resets (default 30 s). */
  stableMs?: number;
  /** Keep-alive ping (default 25 s). */
  pingMs?: number;
  /** Wait for the socket to open (default 15 s). */
  openMs?: number;
  /** Sessions at once (default 64) and handshakes in flight per peer (default 4). */
  maxSessions?: number;
  maxPendingPerPeer?: number;
  handshakeMs?: number;
  rekeyMessages?: number;
  rekeySeconds?: number;
  /** The send queue behind the socket (D-9): pacer, byte cap (default 8 MiB). */
  outbox?: Omit<RelayOutboxOptions, "timer">;
}

export type RelayState =
  | "idle"
  | "connecting"
  | "open"
  | "backoff"
  /** Ended by a typed error that retrying does not fix; see `error`. */
  | "blocked"
  | "stopped";

export interface RelayStatus {
  state: RelayState;
  error: RelayError | null;
  /** Failed attempts since the last open. */
  attempts: number;
}

const HANDSHAKE_MS = 30_000;
const MAX_RETRY_AFTER_S = 3600;
const ENDED_MEMORY = 256;
const MAX_SESSION_ID = 0xffffffff;
const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

const defaultSocket = (url: string, protocols: string[]): RelaySocket =>
  new WebSocket(url, protocols) as unknown as RelaySocket;

/** One session inside the room: a channel whose Noise messages ride SEND and RECV envelopes. */
class RelayLink {
  readonly channel: PeerChannel;
  readonly opened: Promise<ConnectSession>;
  #session: ConnectSession | null = null;
  #settle!: {
    resolve: (s: ConnectSession) => void;
    reject: (e: RelayError) => void;
  };
  #deadline: NodeJS.Timeout;
  #ended = false;
  /** Set once the session is being closed: its last records skip the byte cap. */
  closing = false;

  constructor(
    readonly peer: Uint8Array,
    readonly sessionId: number,
    readonly key: string,
    private readonly role: "initiator" | "responder",
    channel: Omit<PeerSessionOptions, "send" | "onEvent" | "mode" | "role">,
    private readonly out: (noise: Uint8Array) => void,
    private readonly cb: {
      onRing(jws: string, epoch: number): void;
      onTrust(jws: string): void;
      onRingWanted(): void;
      onEstablished(s: ConnectSession): void;
      onEnded(l: RelayLink): void;
    },
    handshakeMs: number,
  ) {
    printAs(this, () => ({ link: "RelayLink", session: sessionId }));
    this.opened = new Promise((resolve, reject) => {
      this.#settle = { resolve, reject };
    });
    this.opened.catch(() => undefined);
    this.channel = new PeerChannel({
      ...channel,
      mode: assertRelayMode("a"),
      role,
      send: (noise) => this.out(noise),
      onEvent: (e) => this.#event(e),
    });
    this.#deadline = setTimeout(() => {
      void this.channel.close("peer_bye");
      this.finish({ code: "handshake_failed", byPeer: false });
    }, handshakeMs);
    this.#deadline.unref();
  }

  /** The send queue is full: end this session `peer_busy`, and say so to the peer. */
  overflow(): void {
    if (this.#ended) return;
    this.closing = true;
    void this.channel.close("peer_busy").catch(() => undefined);
    this.finish({ code: "peer_busy", byPeer: false });
  }

  get ended(): boolean {
    return this.#ended;
  }

  #event(e: SessionEvent): void {
    switch (e.type) {
      case "established": {
        if (e.peerDeviceId === undefined) break;
        // The certificate, not the room's stamp, names the peer; they must agree.
        if (e.peerDeviceId !== base64UrlEncodeBytes(this.peer)) {
          void this.channel.close("peer_bye");
          this.finish(
            { code: "handshake_failed", byPeer: false },
            "wrong_peer",
          );
          break;
        }
        clearTimeout(this.#deadline);
        this.#session = new ConnectSession(
          this,
          e.peerDeviceId,
          e.caps,
          e.hello as PeerHello,
          this.role,
          "relay",
          "relay",
        );
        this.cb.onEstablished(this.#session);
        this.#settle.resolve(this.#session);
        break;
      }
      case "record":
        routeRecord(this, this.#session, e.recordType, e.body);
        break;
      case "ring":
        this.cb.onRing(e.jws, e.epoch);
        break;
      case "trust-unverified":
        this.cb.onTrust(e.jws);
        break;
      case "ring-wanted":
        this.cb.onRingWanted();
        break;
      case "closed":
        this.finish({ code: e.code, byPeer: e.byPeer });
        break;
      default:
        break;
    }
  }

  /** The socket is gone or the room dropped the peer: end without a word. */
  lost(): void {
    this.finish({ code: "connection_lost", byPeer: false });
  }

  finish(c: SessionClosed, why: RelayErrorReason = "handshake_failed"): void {
    if (this.#ended) return;
    this.#ended = true;
    clearTimeout(this.#deadline);
    const live = this.#session;
    if (live === null)
      this.#settle.reject(
        new RelayError(why, "The peer was not admitted over the relay.", {
          closeCode: c.code,
        }),
      );
    else live.ended(c);
    this.cb.onEnded(this);
  }
}

export class RelayService {
  #o: RelayOptions;
  #state: RelayState = "idle";
  #error: RelayError | null = null;
  #attempts = 0;
  #stopped = false;
  #started = false;
  #ws: RelaySocket | null = null;
  #open = false;
  #members = new Set<string>();
  #links = new Map<string, RelayLink>();
  #ended: string[] = [];
  #onSession = new Set<(s: ConnectSession) => void>();
  #onState = new Set<(s: RelayStatus) => void>();
  #onMembers = new Set<(m: string[]) => void>();
  #waiters: { resolve: () => void; reject: (e: RelayError) => void }[] = [];
  #cancel: (() => void) | null = null;
  #pingCancel: (() => void) | null = null;
  #wake: (() => void) | null = null;
  #lastLimit: number | null = null;
  #chain: Promise<unknown> = Promise.resolve();
  #out: RelayOutbox | null = null;
  #docs: PeerDocs;
  #id: { at: number; v: LanIdentity } | null = null;

  constructor(
    private readonly src: RelaySource,
    o: RelayOptions = {},
  ) {
    this.#o = o;
    this.#docs = new PeerDocs(src, () => {
      this.#id = null;
    });
    printAs(this, () => ({ service: "RelayService", state: this.#state }));
  }

  /** Begin connecting. Resolves when the first attempt has been started; use `ready()` to wait. */
  start(): void {
    if (this.#started || this.#stopped) return;
    this.#started = true;
    void this.#loop();
  }

  get status(): RelayStatus {
    return { state: this.#state, error: this.#error, attempts: this.#attempts };
  }

  onState(fn: (s: RelayStatus) => void): () => void {
    this.#onState.add(fn);
    return () => this.#onState.delete(fn);
  }

  /** Called for each inbound session once it is open and admitted. */
  onSession(fn: (s: ConnectSession) => void): () => void {
    this.#onSession.add(fn);
    return () => this.#onSession.delete(fn);
  }

  /** Called when the room's member list changes (device ids of this person's online devices). */
  onMembers(fn: (m: string[]) => void): () => void {
    this.#onMembers.add(fn);
    return () => this.#onMembers.delete(fn);
  }

  onNotice(fn: (n: ConnectNotice) => void): () => void {
    return this.#docs.onNotice(fn);
  }

  /** The person's devices online in the room, as of the last MEMBERS (this device included). */
  members(): string[] {
    return [...this.#members];
  }

  /** Ask the room who is online now (a LIST); resolves on the answer or after `timeoutMs`.
   *  The room never pushes joins, so this is how a device learns of a new arrival. */
  async refreshMembers(timeoutMs = 2000): Promise<string[]> {
    if (!this.#open) return this.members();
    await new Promise<void>((resolve) => {
      const cancel = (this.#o.timer ?? defaultTimer)(done, timeoutMs);
      const off = this.onMembers(done);
      function done(): void {
        off();
        cancel();
        resolve();
      }
      this.#sendEnv({ op: "list" });
    });
    return this.members();
  }

  /** Resolves once the socket is open; rejects with the typed error when the loop is blocked. */
  ready(timeoutMs: number = this.#o.openMs ?? 15_000): Promise<void> {
    if (this.#open) return Promise.resolve();
    if (this.#state === "blocked" || this.#state === "stopped")
      return Promise.reject(this.#error ?? this.#stoppedError());
    if (!this.#started) this.start();
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      this.#waiters.push(w);
      const cancel = (this.#o.timer ?? defaultTimer)(() => {
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

  /** After a block (a quota), try again now. */
  resume(): void {
    if (this.#stopped) return;
    if (this.#state === "blocked") {
      this.#error = null;
      this.#attempts = 0;
      this.#started = true;
      void this.#loop();
    } else this.#wake?.();
  }

  /** Dial a device of the person over the relay and run the handshake. */
  async dial(deviceId: string): Promise<ConnectSession> {
    await this.ready();
    let peer: Uint8Array;
    try {
      peer = deviceIdBytes(deviceId);
    } catch {
      throw new RelayError("unknown_peer", "That is not a device id.");
    }
    const id = await this.#identity(false);
    if (deviceId === id.deviceId || !id.roster.includes(deviceId))
      throw new RelayError(
        "unknown_peer",
        "That device is not one of this person's devices.",
      );
    const sessionId = this.#newSessionId(peer);
    const link = this.#makeLink(peer, sessionId, "initiator", id);
    if (link === null)
      throw new RelayError("busy", "Too many relay sessions are open.");
    void link.channel.start();
    let session: ConnectSession;
    try {
      session = await link.opened;
    } catch (e) {
      if (e instanceof RelayError) throw e;
      throw new RelayError("handshake_failed", "The handshake failed.", {
        cause: e,
      });
    }
    return session;
  }

  /** Stop at once: no goodbyes, nothing waited on. The sign-out bound's force path. */
  abort(): void {
    void this.stop(false);
  }

  async stop(graceful = true): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#docs.close();
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
    } else {
      this.#out?.clear();
      this.#id = null;
    }
    this.#out = null;
    this.#open = false;
    this.#ws = null;
    try {
      ws?.close(1000);
    } catch {
      // already closed
    }
    for (const l of [...this.#links.values()]) l.lost();
    this.#flush(this.#stoppedError());
  }

  // ── The connect loop ────────────────────────────────────────────────────────────────────────

  async #loop(): Promise<void> {
    while (!this.#stopped) {
      this.#set("connecting");
      let closeCode: number | null = null;
      let waitS = 0;
      try {
        const grant = await this.src.ticket();
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
        if (err.reason === "disabled" || err.reason === "quota")
          return this.#block(err);
        waitS = err.retryAfterSeconds ?? 0;
      }
      if (this.#stopped) return;
      const stop = this.#afterClose(closeCode);
      if (stop !== null) return this.#block(stop);
      this.#attempts++;
      this.#set("backoff");
      // Retry-After is the server's hint, capped so a bad value cannot stall or spin the loop.
      await this.#sleep(
        Math.max(this.#backoff(), Math.min(waitS, MAX_RETRY_AFTER_S) * 1000),
      );
    }
  }

  /** What a close means for the loop: null to reconnect, else the error that ends it. */
  #afterClose(code: number | null): RelayError | null {
    const limit = this.#lastLimit;
    this.#lastLimit = null;
    if (code === null) return null;
    if (code === 4009)
      return new RelayError(
        "replaced",
        "Another connection of this device took the relay socket.",
        { closeCode: code },
      );
    if (code === 4003) {
      // The roster this device holds is out of date: fetch it, and stop if it keeps happening.
      this.#docs.wantRing();
      if (++this.#notMember >= 3)
        return new RelayError(
          "not_member",
          "The room does not know this device.",
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
  #notMember = 0;

  #block(e: RelayError): void {
    this.#error = e;
    this.#open = false;
    this.#set("blocked");
    this.#flush(e);
  }

  /** Open one socket and run it to its close. Resolves with the close code. */
  #session(grant: RelayGrant): Promise<number | null> {
    return new Promise((resolve) => {
      let ws: RelaySocket;
      try {
        ws = (this.#o.webSocket ?? defaultSocket)(grant.url, [
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
        ...this.#o.outbox,
        ...(this.#o.timer !== undefined ? { timer: this.#o.timer } : {}),
      });
      this.#out = out;
      let done = false;
      let openedAt = 0;
      const cancelOpen = (this.#o.timer ?? defaultTimer)(() => {
        try {
          ws.close(1000);
        } catch {
          // gone
        }
        finish(null);
      }, this.#o.openMs ?? 15_000);
      const finish = (code: number | null): void => {
        if (done) return;
        done = true;
        cancelOpen();
        this.#pingCancel?.();
        const was = this.#open;
        if (was && performance.now() - openedAt >= (this.#o.stableMs ?? 30_000))
          this.#attempts = 0;
        this.#open = false;
        if (this.#ws === ws) this.#ws = null;
        out.clear();
        if (this.#out === out) this.#out = null;
        this.#members.clear();
        for (const l of [...this.#links.values()]) l.lost();
        if (was) this.#emitMembers();
        resolve(code);
      };
      ws.onopen = () => {
        if (this.#stopped) return;
        cancelOpen();
        this.#open = true;
        // A socket that is accepted and then dropped must not reset the backoff: only a stable
        // one does (see `finish`).
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
        if (bytes === null) {
          this.#refuse(ws);
          return;
        }
        this.#chain = this.#chain
          .then(() => (this.#ws === ws ? this.#handle(ws, bytes) : undefined))
          .catch(() => this.#refuse(ws));
      };
      ws.onerror = () => undefined;
      ws.onclose = (ev) => finish(typeof ev.code === "number" ? ev.code : null);
    });
  }

  #refuse(ws: RelaySocket): void {
    // A refused envelope: close 1002, treat later frames as lost.
    try {
      ws.close(1002);
    } catch {
      // gone
    }
  }

  #schedulePing(ws: RelaySocket): void {
    const timer = this.#o.timer ?? defaultTimer;
    const tick = (): void => {
      if (this.#ws !== ws || this.#stopped) return;
      this.#sendEnv({ op: "ping", data: randomBytes(8) });
      this.#sendEnv({ op: "list" });
      this.#pingCancel = timer(tick, this.#o.pingMs ?? 25_000);
    };
    this.#pingCancel = timer(tick, this.#o.pingMs ?? 25_000);
  }

  #sendEnv(m: Parameters<typeof encodeRelay>[0], force = true): boolean {
    return !this.#open || (this.#out?.send(m, force) ?? true);
  }

  /** A session's Noise message, paced; one past the byte cap ends that session `peer_busy`. */
  #sendSession(
    link: RelayLink,
    peer: Uint8Array,
    session: number,
    noise: Uint8Array,
  ): void {
    if (!this.#sendEnv({ op: "send", to: peer, session, noise }, link.closing))
      link.overflow();
  }

  async #handle(ws: RelaySocket, bytes: Uint8Array): Promise<void> {
    const m = decodeRelay("toClient", bytes);
    if (m === null) return this.#refuse(ws);
    switch (m.op) {
      case "recv":
        return this.#recv(m.from, m.session, m.noise);
      case "members": {
        this.#members = new Set(m.devices.map((d) => base64UrlEncodeBytes(d)));
        this.#emitMembers();
        return;
      }
      case "ring": {
        // The roster changed. Fetch the newer one under the normal replacement rules; the
        // epoch is only a hint of whether it is newer than the one held.
        const id = await this.#identity(false).catch(() => null);
        if (id === null || m.epoch > id.ringEpoch) this.#docs.wantRing();
        return;
      }
      case "gone": {
        const dev = hex(m.device);
        for (const l of [...this.#links.values()])
          if (hex(l.peer) === dev) l.lost();
        this.#members.delete(base64UrlEncodeBytes(m.device));
        this.#emitMembers();
        return;
      }
      case "limit": {
        this.#lastLimit = m.reason;
        if (m.reason === 1) this.#out?.halve();
        const reason: RelayErrorReason =
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
      case "pong":
        return;
      default:
        // A client-to-room op in the wrong direction cannot decode here; nothing else exists.
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
    // A first message of a session the peer opened. Only the person's own devices may.
    const id = await this.#identity(false).catch(() => null);
    if (id === null) return;
    const fromId = base64UrlEncodeBytes(from);
    if (fromId === id.deviceId || !id.roster.includes(fromId)) return;
    const pending = [...this.#links.values()].filter(
      (l) => !l.ended && hex(l.peer) === hex(from),
    ).length;
    if (pending >= (this.#o.maxPendingPerPeer ?? 4)) return;
    const link = this.#makeLink(from, session, "responder", id);
    if (link === null) return;
    void link.channel.receive(noise);
  }

  #makeLink(
    peer: Uint8Array,
    sessionId: number,
    role: "initiator" | "responder",
    id: LanIdentity,
  ): RelayLink | null {
    if (this.#links.size >= (this.#o.maxSessions ?? 64)) return null;
    const key = `${hex(peer)}:${sessionId}`;
    const link: RelayLink = new RelayLink(
      peer,
      sessionId,
      key,
      role,
      channelBase(
        id,
        this.#o,
        () => this.src.now(),
        () => this.#docs.pushed,
      ),
      (noise) => this.#sendSession(link, peer, sessionId, noise),
      {
        ...this.#docs.hooks,
        onEstablished: (s) => {
          if (role === "responder") for (const f of [...this.#onSession]) f(s);
        },
        onEnded: (l) => {
          this.#links.delete(l.key);
          this.#ended.push(l.key);
          if (this.#ended.length > ENDED_MEMORY) this.#ended.shift();
        },
      },
      this.#o.handshakeMs ?? HANDSHAKE_MS,
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

  async #identity(force: boolean): Promise<LanIdentity> {
    const now = this.src.now();
    if (
      !force &&
      this.#id !== null &&
      now - this.#id.at < 30 &&
      this.#id.v.certExpiresAt - now > 60
    )
      return this.#id.v;
    const v = await this.src.load();
    this.#id = { at: now, v };
    if (this.#docs.pushed !== null && this.#docs.pushed.epoch <= v.ringEpoch)
      this.#docs.pushed = null;
    return v;
  }

  // ── Backoff and bookkeeping ─────────────────────────────────────────────────────────────────

  #backoff(): number {
    const base = this.#o.backoffBaseMs ?? 1000;
    const max = this.#o.backoffMaxMs ?? 60_000;
    const cap = Math.min(max, base * 2 ** Math.min(this.#attempts - 1, 16));
    // Equal jitter: half fixed, half random, never under the floor.
    const jittered = Math.floor(
      cap / 2 + ((this.#o.random ?? Math.random)() * cap) / 2,
    );
    return Math.max(this.#o.backoffMinMs ?? 500, jittered);
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const cancel = (this.#o.timer ?? defaultTimer)(() => {
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
    const st = this.status;
    for (const f of [...this.#onState]) f(st);
  }

  #emitMembers(): void {
    const m = this.members();
    for (const f of [...this.#onMembers]) f(m);
  }

  #flush(e: RelayError): void {
    for (const w of this.#waiters.splice(0)) w.reject(e);
  }

  #stoppedError(): RelayError {
    return new RelayError("stopped", "The relay is stopped.");
  }
}

function toBytes(d: unknown): Uint8Array | null {
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d))
    return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
  return null;
}
